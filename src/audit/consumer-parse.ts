/**
 * The existing proba-audit Redis consumer reads only:
 *   payload = JSON.parse(fields.data)
 * then validateAuditEvent(payload). Extra stream fields are ignored.
 */
import { validateAuditEvent, type AuditEvent } from '../protocol.js';

export function parseConsumerStreamFields(fields: Record<string, string>): AuditEvent {
  const parsed = validateAuditEvent(JSON.parse(fields.data) as unknown);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'audit consumer rejected event');
  }
  return parsed.data;
}
