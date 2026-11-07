/**
 * Typed failures for the one-turn LLM service. Auth failures fail closed.
 */
export class NotImplementedError extends Error {
  readonly code = 'not_implemented';

  constructor(what: string) {
    super(`not implemented: ${what}`);
    this.name = 'NotImplementedError';
  }
}

export class ConfigError extends Error {
  readonly code = 'config_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class RequestValidationError extends Error {
  readonly code = 'invalid_request';

  constructor(message: string) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

export class HostRefusedError extends Error {
  readonly code = 'host_refused';

  constructor(host: string) {
    super(`downstream host is not allowlisted: ${host}`);
    this.name = 'HostRefusedError';
  }
}

export class ModelRefusedError extends Error {
  readonly code = 'model_refused';

  constructor(model: string) {
    super(`model is not allowlisted: ${model}`);
    this.name = 'ModelRefusedError';
  }
}

export class TurnAbortedError extends Error {
  readonly code = 'aborted';

  constructor(message = 'turn was cancelled or timed out') {
    super(message);
    this.name = 'TurnAbortedError';
  }
}

export class AuditUnavailableError extends Error {
  readonly code = 'audit_unavailable';

  constructor(message = 'audit publisher is not ready') {
    super(message);
    this.name = 'AuditUnavailableError';
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = 'idempotency_conflict';

  constructor(message = 'idempotency key was reused with a different request') {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * The provider call was dispatched but the outcome is not a clear 2xx or 4xx.
 * The turn is recorded so a retry with the same key will not send another paid request.
 */
export class AmbiguousProviderError extends Error {
  readonly code = 'provider_ambiguous';

  constructor(message = 'provider result is ambiguous; this turn will not be retried') {
    super(message);
    this.name = 'AmbiguousProviderError';
  }
}
