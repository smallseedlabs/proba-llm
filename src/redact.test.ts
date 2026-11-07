import { describe, expect, it } from 'vitest';
import { maskSecretsInText, redactDetails } from './redact.js';

describe('maskSecretsInText', () => {
  it('masks bearer tokens, labelled secrets and cards, not ordinary campaign text', () => {
    const masked = maskSecretsInText('Bearer abc.def.ghi password: hunter2 card 4111 1111 1111 1111 spend 50');
    expect(masked.text).toContain('Bearer [REDACTED]');
    expect(masked.text).toContain('[REDACTED]');
    expect(masked.text).toContain('[REDACTED_CARD]');
    expect(masked.text).toContain('spend 50');
    expect(masked.redactions).toBeGreaterThanOrEqual(3);
  });

  it('redacts secret-named details keys', () => {
    const details = redactDetails({ apiKey: 'sk-secret', model: 'deepseek-chat', tokens: 3 });
    expect(details.apiKey).toBe('[REDACTED]');
    expect(details.model).toBe('deepseek-chat');
  });
});
