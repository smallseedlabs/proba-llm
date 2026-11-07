/**
 * proba-llm public surface.
 *
 * One model turn per request. Gateway owns context enrichment, loops and
 * guarded tools. Hub calls gateway.
 */
export {
  AmbiguousProviderError,
  ConfigError,
  IdempotencyConflictError,
  NotImplementedError,
  RequestValidationError,
} from './errors.js';
export {
  AUDIT_ACTIONS,
  AUDIT_CONTENT_KINDS,
  AUDIT_CONTENT_MAX_CHARS,
  AUDIT_EVENT_VERSION,
  buildAuditContent,
  buildAuditEvent,
  generateSpanId,
  getAuditActionInfo,
  validateAuditEvent,
} from './protocol.js';
export type {
  AuditContent,
  AuditEvent,
  AuditEventInput,
  CommandEnvelope,
  EventEnvelope,
} from './protocol.js';
export { IdentityRejectedError, LlmProviderError, TokenVerificationError } from './ports/index.js';
export type {
  AuditPublisher,
  Clock,
  HttpTransport,
  IdentityCredentials,
  IdentityResolver,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmUsage,
  ResolvedIdentity,
  ServiceAuth,
  VerifiedCaller,
} from './ports/index.js';
export { SingleTurnHandler } from './handler/index.js';
export type { SingleTurnHandlerDeps } from './handler/index.js';
export { LLM_SERVICE_NAME } from './types/index.js';
export type {
  CompleteRequest,
  CostEstimate,
  LlmServiceConfig,
  SpanId,
  TraceId,
  TurnRequest,
  TurnResponse,
  WorkspaceId,
} from './types/index.js';
export { completeRequestSchema } from './types/index.js';
export { loadConfig } from './config.js';
export { createRuntime } from './runtime.js';
export type { LlmRuntime, RuntimeOverrides } from './runtime.js';
export { DeepSeekProvider, LogAuditPublisher, RedisAuditPublisher, SystemClock } from './adapters/index.js';
export { buildApp } from './http/app.js';
export { LLM_AUDIENCE, DEFAULT_CALLER_ISSUERS, DEFAULT_CALLER_SUBJECTS } from './auth/constants.js';
