/**
 * Shared protocol types and helpers. Do not invent parallel audit, command or
 * event schemas here. Hub, gateway and this service share `traceId` and the
 * AuditEvent envelope; the durable event system (proba-audit consumer) writes
 * the DB, including compressed content bodies and metadata indexes.
 */
export type {
  AuditContent,
  AuditEvent,
  AuditEventInput,
  CommandEnvelope,
  EventEnvelope,
} from '@smallseedlabs/proba-protocol';

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
} from '@smallseedlabs/proba-protocol';
