/**
 * Single-turn handler: one provider.complete per new idempotency key.
 * Gateway owns loops, context and tool execution.
 */

import {
  AUDIT_CONTENT_MAX_CHARS,
  buildAuditContent,
  buildAuditEvent,
  generateSpanId,
  getAuditActionInfo,
  type AuditEvent,
} from '../protocol.js';
import {
  AmbiguousProviderError,
  IdempotencyConflictError,
  ModelRefusedError,
  RequestValidationError,
  TurnAbortedError,
} from '../errors.js';
import { hashedTurnKey, requestFingerprint } from '../audit/fingerprint.js';
import { splitAuditBody } from '../audit/body-chunks.js';
import { gzipBytes } from '../compress.js';
import { maskSecretsInText, redactDetails } from '../redact.js';
import type { AuditPublisher } from '../ports/audit-publisher.js';
import type { Clock } from '../ports/clock.js';
import type { LlmProvider, LlmResponse, VerifiedCaller } from '../ports/index.js';
import type { TurnRecord, TurnStore } from '../ports/turn-store.js';
import { LlmProviderError } from '../ports/provider.js';
import { costOf } from '../cost.js';
import { LLM_SERVICE_NAME } from '../types/config.js';
import type { LlmServiceConfig, TurnRequest, TurnResponse } from '../types/index.js';

export interface SingleTurnHandlerDeps {
  provider: LlmProvider;
  audit: AuditPublisher;
  clock: Clock;
  config: LlmServiceConfig;
  turns: TurnStore;
}

function finishReasonOf(raw: string | undefined, hasTools: boolean): TurnResponse['finishReason'] {
  if (raw === 'tool_calls' || (hasTools && raw === 'stop')) return hasTools ? 'tool_calls' : 'stop';
  if (raw === 'length') return 'length';
  if (raw === 'stop') return 'stop';
  if (hasTools) return 'tool_calls';
  return raw ? 'unknown' : hasTools ? 'tool_calls' : 'stop';
}

function promptText(request: TurnRequest): string {
  return request.messages.map((m) => `${m.role}: ${m.content}`).join('\n');
}

function responseText(result: LlmResponse): string {
  const tools = result.toolCalls?.map((t) => `${t.name}(${t.arguments})`).join('\n') ?? '';
  return [result.content ?? '', tools].filter((s) => s.length > 0).join('\n');
}

export class SingleTurnHandler {
  private readonly gates = new Map<string, Promise<void>>();

  constructor(private readonly deps: SingleTurnHandlerDeps) {}

  async handle(request: TurnRequest, caller: VerifiedCaller, signal?: AbortSignal, idempotencyKey?: string): Promise<TurnResponse> {
    this.assertLimits(request);
    const key = hashedTurnKey(caller.issuer, caller.subject, idempotencyKey ?? request.idempotencyKey ?? request.traceId);
    return this.serialize(key, () => this.execute(key, request, caller, signal, idempotencyKey ?? request.idempotencyKey ?? request.traceId));
  }

  private assertLimits(request: TurnRequest): void {
    const { config, provider } = this.deps;
    if (request.messages.length > config.limits.maxMessages) {
      throw new RequestValidationError(`messages exceed limit ${config.limits.maxMessages}`);
    }
    for (const message of request.messages) {
      if (message.content.length > config.limits.maxMessageChars) {
        throw new RequestValidationError(`a message exceeds ${config.limits.maxMessageChars} characters`);
      }
    }
    if ((request.tools?.length ?? 0) > config.limits.maxTools) {
      throw new RequestValidationError(`tools exceed limit ${config.limits.maxTools}`);
    }
    const model = request.model ?? provider.model;
    if (config.allowedModels.length > 0 && !config.allowedModels.includes(model)) {
      throw new ModelRefusedError(model);
    }
  }

  private async serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.gates.get(key) ?? Promise.resolve();
    const current = previous.then(fn, fn);
    this.gates.set(
      key,
      current.then(
        () => undefined,
        () => undefined
      )
    );
    return current;
  }

  private async execute(
    key: string,
    request: TurnRequest,
    caller: VerifiedCaller,
    signal: AbortSignal | undefined,
    idempotencyKey: string
  ): Promise<TurnResponse> {
    const fingerprint = requestFingerprint(request);
    const existing = await this.deps.turns.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new IdempotencyConflictError();
      if (existing.state === 'completed' && existing.response) {
        await this.relay(existing);
        return existing.response;
      }
      if (existing.state === 'failed') {
        await this.relay(existing);
        throw new LlmProviderError(existing.errorMessage ?? 'provider_error', false);
      }
      if (existing.state === 'ambiguous' || existing.state === 'inflight') {
        await this.relay(existing);
        throw new AmbiguousProviderError();
      }
    }

    const started = this.deps.clock.now();
    const inflight: TurnRecord = {
      key,
      callerIss: caller.issuer,
      callerSub: caller.subject,
      idempotencyKey,
      fingerprint,
      state: 'inflight',
      events: [],
      publishedEventIds: [],
      updatedAt: this.deps.clock.isoNow(),
    };
    await this.deps.turns.put(inflight);

    const model = request.model ?? this.deps.provider.model;
    const maxTokens = Math.min(request.maxTokens ?? this.deps.config.limits.maxTokens, this.deps.config.limits.maxTokens);
    const callSpan = generateSpanId();
    let result: LlmResponse;
    try {
      result = await this.deps.provider.complete({
        messages: request.messages,
        tools: request.tools,
        json: request.json,
        temperature: request.temperature,
        maxTokens,
        model,
        signal,
      });
    } catch (err) {
      if (err instanceof TurnAbortedError || (err instanceof Error && err.name === 'AbortError')) {
        const events = this.buildEvents(request, caller, {
          kind: 'ambiguous',
          spanId: callSpan,
          durationMs: this.deps.clock.now().getTime() - started.getTime(),
          model,
          errorMessage: err instanceof Error ? err.message : 'aborted',
        });
        await this.deps.turns.put({
          ...inflight,
          state: 'ambiguous',
          events,
          errorCode: 'provider_ambiguous',
          errorMessage: err instanceof Error ? err.message : 'aborted',
          updatedAt: this.deps.clock.isoNow(),
        });
        await this.relay(await this.require(key));
        throw new AmbiguousProviderError();
      }
      const message = err instanceof Error ? err.message : 'provider_error';
      const events = this.buildEvents(request, caller, {
        kind: 'failed',
        spanId: callSpan,
        durationMs: this.deps.clock.now().getTime() - started.getTime(),
        model,
        errorMessage: message,
      });
      await this.deps.turns.put({
        ...inflight,
        state: 'failed',
        events,
        errorCode: err instanceof LlmProviderError ? String(err.status ?? 'provider_error') : 'provider_error',
        errorMessage: message.slice(0, 300),
        updatedAt: this.deps.clock.isoNow(),
      });
      await this.relay(await this.require(key));
      throw err;
    }

    const latencyMs = this.deps.clock.now().getTime() - started.getTime();
    const toolCalls = result.toolCalls;
    const hasTools = Boolean(toolCalls && toolCalls.length > 0);
    const response: TurnResponse = {
      message: {
        role: 'assistant',
        content: result.content,
        ...(toolCalls ? { toolCalls } : {}),
        ...(result.reasoningContent != null && result.reasoningContent !== ''
          ? { reasoningContent: result.reasoningContent }
          : {}),
      },
      finishReason: finishReasonOf(result.finishReason, hasTools),
      model: result.model,
      provider: this.deps.provider.name,
      usage: result.usage ?? {},
      latencyMs,
      cost: costOf(result.usage, this.deps.config.pricing),
      cached: result.usage?.cachedTokens !== undefined ? result.usage.cachedTokens > 0 : undefined,
    };
    const events = this.buildEvents(request, caller, {
      kind: 'completed',
      spanId: callSpan,
      durationMs: latencyMs,
      model: result.model,
      result,
      response,
    });
    await this.deps.turns.put({
      ...inflight,
      state: 'completed',
      response,
      events,
      updatedAt: this.deps.clock.isoNow(),
    });
    await this.relay(await this.require(key));
    return response;
  }

  private async require(key: string): Promise<TurnRecord> {
    const row = await this.deps.turns.get(key);
    if (!row) throw new Error('turn record missing after persist');
    return row;
  }

  /** Publish unpublished protocol events. Failures stay in the outbox; the client already has a durable outcome. */
  async relay(record: TurnRecord): Promise<void> {
    for (const event of record.events) {
      if (record.publishedEventIds.includes(event.eventId)) continue;
      try {
        await this.deps.audit.publish(event);
        await this.deps.turns.markPublished(record.key, event.eventId);
        record.publishedEventIds.push(event.eventId);
      } catch {
        return;
      }
    }
  }

  async relayPending(): Promise<void> {
    for (const row of await this.deps.turns.unpublished()) {
      await this.relay(row);
    }
  }

  private buildEvents(
    request: TurnRequest,
    caller: VerifiedCaller,
    ctx: {
      kind: 'completed' | 'failed' | 'ambiguous';
      spanId: string;
      durationMs: number;
      model: string;
      result?: LlmResponse;
      response?: TurnResponse;
      errorMessage?: string;
    }
  ): AuditEvent[] {
    const promptMasked = maskSecretsInText(promptText(request), { pii: this.deps.config.audit.contentMaskPii });
    const replyMasked = ctx.result
      ? maskSecretsInText(responseText(ctx.result), { pii: this.deps.config.audit.contentMaskPii })
      : { text: '', redactions: 0 };
    const promptChunks = splitAuditBody(promptMasked.text);
    const replyChunks = splitAuditBody(replyMasked.text);
    const events: AuditEvent[] = [];
    const promptMeta = {
      provider: this.deps.provider.name,
      model: ctx.model,
      promptChars: promptMasked.text.length,
      promptGzipBytes: gzipBytes(promptMasked.text),
      promptChunks: promptChunks.length,
      responseChars: replyMasked.text.length,
      responseGzipBytes: gzipBytes(replyMasked.text),
      responseChunks: replyChunks.length,
      contentMaxChars: AUDIT_CONTENT_MAX_CHARS,
      redactions: promptMasked.redactions + replyMasked.redactions,
      callerIss: caller.issuer,
      callerSub: caller.subject,
    };

    if (ctx.kind !== 'completed') {
      events.push(
        this.event(request, caller, {
          action: 'brain.error',
          outcome: 'failure',
          spanId: ctx.spanId,
          durationMs: ctx.durationMs,
          errorCode: ctx.kind === 'ambiguous' ? 'provider_ambiguous' : 'provider_error',
          errorMessage: ctx.errorMessage,
          details: promptMeta,
          content: promptChunks[0] ? { kind: 'prompt', text: promptChunks[0], redactions: promptMasked.redactions } : undefined,
        })
      );
      this.pushChunks(events, request, caller, ctx.spanId, 'prompt', promptChunks.slice(1), promptMasked.redactions, promptChunks.length);
      return events;
    }

    const result = ctx.result!;
    const response = ctx.response!;
    events.push(
      this.event(request, caller, {
        action: 'brain.llm_call',
        outcome: 'success',
        spanId: ctx.spanId,
        durationMs: ctx.durationMs,
        cost: {
          tokensIn: result.usage?.promptTokens,
          tokensOut: result.usage?.completionTokens,
          ...(response.cost.estimate === 'unknown' ? {} : { amount: response.cost.estimate, currency: response.cost.currency }),
        },
        details: {
          ...promptMeta,
          finishReason: response.finishReason,
          toolCallCount: result.toolCalls?.length ?? 0,
          cachedTokens: result.usage?.cachedTokens,
          reasoningTokens: result.usage?.reasoningTokens,
          costEstimate: response.cost.estimate,
          pricingVersion: response.cost.estimate === 'unknown' ? null : response.cost.pricingVersion,
        },
        content: promptChunks[0] ? { kind: 'prompt', text: promptChunks[0], redactions: promptMasked.redactions } : undefined,
      })
    );
    this.pushChunks(events, request, caller, ctx.spanId, 'prompt', promptChunks.slice(1), promptMasked.redactions, promptChunks.length);
    if (replyChunks.length > 0) {
      events.push(
        this.event(request, caller, {
          action: 'brain.reply_generated',
          outcome: 'success',
          parentSpanId: ctx.spanId,
          durationMs: ctx.durationMs,
          details: { length: replyMasked.text.length, replyChunks: replyChunks.length, toolCallCount: result.toolCalls?.length ?? 0 },
          content: { kind: 'brain_reply', text: replyChunks[0], redactions: replyMasked.redactions },
        })
      );
      this.pushChunks(events, request, caller, ctx.spanId, 'reply', replyChunks.slice(1), replyMasked.redactions, replyChunks.length);
    }
    for (const call of result.toolCalls ?? []) {
      events.push(
        this.event(request, caller, {
          action: 'tool.proposed',
          outcome: 'partial',
          parentSpanId: ctx.spanId,
          details: { tool: call.name, parameterBytes: call.arguments.length },
        })
      );
    }
    return events;
  }

  private pushChunks(
    events: AuditEvent[],
    request: TurnRequest,
    caller: VerifiedCaller,
    parentSpanId: string,
    part: 'prompt' | 'reply',
    rest: string[],
    redactions: number,
    total: number
  ): void {
    rest.forEach((text, i) => {
      events.push(
        this.event(request, caller, {
          action: part === 'prompt' ? 'brain.prompt_chunk' : 'brain.reply_chunk',
          outcome: 'success',
          parentSpanId,
          details: { part, chunkIndex: i + 2, chunkCount: total },
          content: { kind: part === 'prompt' ? 'prompt' : 'brain_reply', text, redactions },
        })
      );
    });
  }

  private event(
    request: TurnRequest,
    caller: VerifiedCaller,
    draft: {
      action: string;
      outcome: AuditEvent['outcome'];
      spanId?: string;
      parentSpanId?: string;
      durationMs?: number;
      errorCode?: string;
      errorMessage?: string;
      cost?: AuditEvent['cost'];
      details?: Record<string, unknown>;
      content?: { kind: string; text: string; redactions: number };
    }
  ): AuditEvent {
    const info = getAuditActionInfo(draft.action);
    return buildAuditEvent({
      traceId: request.traceId,
      spanId: draft.spanId,
      parentSpanId: draft.parentSpanId ?? request.parentSpanId,
      workspaceId: request.workspaceId,
      userId: request.userId,
      goalId: request.goalId,
      threadId: request.threadId,
      actor: { type: 'service', id: caller.subject },
      service: LLM_SERVICE_NAME,
      action: draft.action,
      category: info?.category ?? 'brain',
      outcome: draft.outcome,
      errorCode: draft.errorCode,
      errorMessage: draft.errorMessage ? maskSecretsInText(draft.errorMessage).text : undefined,
      riskLevel: info?.riskLevel,
      cost: draft.cost,
      durationMs: draft.durationMs,
      occurredAt: this.deps.clock.isoNow(),
      details: redactDetails(draft.details ?? {}),
      ...(this.deps.config.audit.contentEnabled && draft.content && draft.content.text.length > 0
        ? { content: buildAuditContent(draft.content.kind, draft.content.text, { redactions: draft.content.redactions }) }
        : {}),
    });
  }
}
