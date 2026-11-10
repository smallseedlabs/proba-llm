import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { IdentityRejectedError } from '../ports/auth.js';
import type { ServiceAuth, VerifiedCaller } from '../ports/auth.js';
import { SingleTurnHandler } from '../handler/single-turn.js';
import {
  AmbiguousProviderError,
  ConfigError,
  HostRefusedError,
  IdempotencyConflictError,
  ModelRefusedError,
  RequestValidationError,
  TurnAbortedError,
} from '../errors.js';
import { LlmProviderError } from '../ports/provider.js';
import { completeRequestSchema } from '../types/turn.js';
import type { LlmServiceConfig } from '../types/config.js';
import { LLM_SERVICE_NAME } from '../types/config.js';
import { buildAuditEvent, getAuditActionInfo } from '../protocol.js';
import type { AuditPublisher } from '../ports/audit-publisher.js';
import type { Clock } from '../ports/clock.js';
import { maskSecretsInText, redactDetails } from '../redact.js';
import type { Logger } from '../logger.js';
import { SlidingWindowRateLimiter } from './rate-limit.js';

export const SERVICE_NAME = LLM_SERVICE_NAME;

export interface AppDeps {
  config: LlmServiceConfig;
  handler: SingleTurnHandler;
  auth: ServiceAuth;
  audit: AuditPublisher;
  clock: Clock;
  logger: Logger;
  ready?: () => Promise<Record<string, 'ok' | 'fail'>>;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function errorBody(code: string, message: string): { error: string; message: string } {
  return { error: code, message };
}

async function deny(
  deps: AppDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  workspaceId = 'unknown'
): Promise<FastifyReply> {
  const info = getAuditActionInfo('auth.denied');
  const event = buildAuditEvent({
    traceId: '00000000-0000-4000-8000-000000000000',
    workspaceId,
    actor: { type: 'service', id: SERVICE_NAME },
    service: SERVICE_NAME,
    action: 'auth.denied',
    category: info?.category ?? 'auth',
    outcome: 'denied',
    errorCode: code,
    riskLevel: info?.riskLevel,
    occurredAt: deps.clock.isoNow(),
    details: redactDetails({ path: request.url, method: request.method }),
  });
  try {
    await deps.audit.publish(event);
  } catch {
    // Still fail closed on the request; do not log token material.
  }
  return reply.status(status).send(errorBody(code, message));
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const limiter = new SlidingWindowRateLimiter(deps.config.limits.rateLimitMax, deps.config.limits.rateLimitWindowMs);
  const app = Fastify({
    logger: false,
    bodyLimit: deps.config.limits.maxRequestBytes,
    trustProxy: false,
  });

  app.get('/health', async () => ({ status: 'ok', service: SERVICE_NAME }));

  app.get('/ready', async (_request, reply) => {
    const checks = deps.ready ? await deps.ready() : { config: 'ok' as const };
    const ready = Object.values(checks).every((v) => v === 'ok');
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      service: SERVICE_NAME,
      checks,
    });
  });

  // Operator-configured unit prices, read by the gateway preflight to enforce GATEWAY_MAX_COST_USD.
  // Public numbers, no caller data. 404 = not configured (the gateway treats that as unknown, never $0).
  app.get('/v1/pricing', async (_request, reply) => {
    const { version, promptUsdPerMillion, completionUsdPerMillion } = deps.config.pricing;
    const positive = (n: number | null): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
    if (!version || !positive(promptUsdPerMillion) || !positive(completionUsdPerMillion)) {
      return reply
        .status(404)
        .send(errorBody('pricing_unconfigured', 'set PRICE_PROMPT_USD_PER_MILLION and PRICE_COMPLETION_USD_PER_MILLION'));
    }
    return reply.send({ promptUsdPerMillion, completionUsdPerMillion, currency: 'USD', version });
  });

  app.post('/v1/complete', async (request, reply) => {
    let caller: VerifiedCaller;
    try {
      caller = await deps.auth.authenticate({ authorization: header(request, 'authorization') });
    } catch (err) {
      if (err instanceof IdentityRejectedError) {
        const status = err.code === 'token_expired' ? 401 : 401;
        return deny(deps, request, reply, status, err.code, 'service token was rejected');
      }
      deps.logger.error({ err: err instanceof Error ? err.name : 'error' }, 'auth verifier unavailable');
      return reply.status(503).send(errorBody('auth_unavailable', 'caller verification unavailable'));
    }

    if (!limiter.allow(`${caller.issuer}\n${caller.subject}`)) {
      return reply.status(429).send(errorBody('rate_limited', 'caller exceeded the request rate limit'));
    }

    const parsed = completeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(errorBody('invalid_request', parsed.error.issues[0]?.message ?? 'invalid request'));
    }
    const body = parsed.data;
    if (body.messages.length > deps.config.limits.maxMessages) {
      return reply.status(400).send(errorBody('invalid_request', 'too many messages'));
    }

    const controller = new AbortController();
    request.raw.on('close', () => controller.abort());
    const idempotencyKey = header(request, 'idempotency-key') ?? body.idempotencyKey ?? body.traceId;
    try {
      const result = await deps.handler.handle(body, caller, controller.signal, idempotencyKey);
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof RequestValidationError || err instanceof ModelRefusedError || err instanceof HostRefusedError) {
        return reply.status(400).send(errorBody(err.code, err.message));
      }
      if (err instanceof IdempotencyConflictError) {
        return reply.status(409).send(errorBody(err.code, err.message));
      }
      if (err instanceof AmbiguousProviderError) {
        return reply.status(504).send(errorBody(err.code, err.message));
      }
      if (err instanceof TurnAbortedError) {
        return reply.status(504).send(errorBody(err.code, err.message));
      }
      if (err instanceof LlmProviderError) {
        const status = err.status === 429 ? 429 : 502;
        return reply.status(status).send(errorBody('provider_error', maskSecretsInText(err.message).text.slice(0, 200)));
      }
      if (err instanceof ConfigError) {
        return reply.status(500).send(errorBody('config_invalid', 'service misconfigured'));
      }
      deps.logger.error({ err: err instanceof Error ? err.name : 'error', traceId: body.traceId }, 'complete failed');
      return reply.status(500).send(errorBody('internal', 'internal error'));
    }
  });

  return app;
}
