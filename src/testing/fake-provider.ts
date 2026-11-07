/**
 * Deterministic LlmProvider test double. Runtime wiring must not import this
 * except when NODE_ENV=test injects it through createRuntime overrides.
 */

import type { LlmProvider, LlmRequest, LlmResponse } from '../ports/provider.js';

export class FakeLlmProvider implements LlmProvider {
  readonly name = 'fake';
  readonly model: string;
  readonly calls: LlmRequest[] = [];
  private readonly responder: (request: LlmRequest, index: number) => LlmResponse | Promise<LlmResponse>;

  constructor(
    options: {
      model?: string;
      responder?: (request: LlmRequest, index: number) => LlmResponse | Promise<LlmResponse>;
    } = {}
  ) {
    this.model = options.model ?? 'fake-test-model';
    this.responder =
      options.responder ??
      (() => ({
        content: 'ok',
        model: this.model,
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
      }));
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.calls.push(request);
    return this.responder(request, this.calls.length - 1);
  }

  async ping(): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    return;
  }
}
