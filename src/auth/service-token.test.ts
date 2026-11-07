import { describe, expect, it } from 'vitest';
import { ServiceTokenAuth } from './service-token.js';
import { LLM_AUDIENCE } from './constants.js';
import { createTestSigner, mintGatewayToken } from '../testing/token-signer.js';
import { TokenVerificationError } from '../ports/auth.js';

const TRACE_NOW = () => new Date('2026-01-01T00:00:00.000Z');

describe('ServiceTokenAuth', () => {
  it('accepts a short-lived gateway token for audience proba-llm', async () => {
    const signer = await createTestSigner();
    const auth = new ServiceTokenAuth({
      keys: signer.keys,
      allowedIssuers: ['proba-gateway'],
      allowedSubjects: ['gateway'],
      now: TRACE_NOW,
    });
    const token = await mintGatewayToken(signer, TRACE_NOW);
    const caller = await auth.authenticate({ authorization: `Bearer ${token}` });
    expect(caller.issuer).toBe('proba-gateway');
    expect(caller.subject).toBe('gateway');
    expect(caller.keyId).toBe(signer.kid);
  });

  it('refuses missing bearer, wrong issuer, wrong audience, expiry and another key', async () => {
    const signer = await createTestSigner();
    const other = await createTestSigner();
    const auth = new ServiceTokenAuth({
      keys: signer.keys,
      allowedIssuers: ['proba-gateway'],
      allowedSubjects: ['gateway'],
      now: TRACE_NOW,
    });
    await expect(auth.authenticate({})).rejects.toBeInstanceOf(TokenVerificationError);
    await expect(auth.authenticate({ authorization: 'Bearer not-a-jwt' })).rejects.toBeInstanceOf(TokenVerificationError);

    const wrongIss = await mintGatewayToken(signer, TRACE_NOW, { iss: 'proba-hub' });
    await expect(auth.authenticate({ authorization: `Bearer ${wrongIss}` })).rejects.toThrow(/issuer/);

    const wrongAud = await mintGatewayToken(signer, TRACE_NOW, { aud: 'proba-memory' });
    await expect(auth.authenticate({ authorization: `Bearer ${wrongAud}` })).rejects.toBeInstanceOf(TokenVerificationError);

    const expired = await mintGatewayToken(signer, TRACE_NOW, { iat: Math.floor(TRACE_NOW().getTime() / 1000) - 600, exp: Math.floor(TRACE_NOW().getTime() / 1000) - 300 });
    await expect(auth.authenticate({ authorization: `Bearer ${expired}` })).rejects.toBeInstanceOf(TokenVerificationError);

    const alien = await mintGatewayToken(other, TRACE_NOW);
    await expect(auth.authenticate({ authorization: `Bearer ${alien}` })).rejects.toBeInstanceOf(TokenVerificationError);

    const longLived = await mintGatewayToken(signer, TRACE_NOW, {
      iat: Math.floor(TRACE_NOW().getTime() / 1000),
      exp: Math.floor(TRACE_NOW().getTime() / 1000) + 121,
    });
    await expect(auth.authenticate({ authorization: `Bearer ${longLived}` })).rejects.toThrow(/longer than/);
  });

  it('does not treat caller-supplied identity headers as identity; only the verified token', async () => {
    const signer = await createTestSigner();
    const auth = new ServiceTokenAuth({
      keys: signer.keys,
      allowedIssuers: ['proba-gateway'],
      allowedSubjects: ['gateway'],
      now: TRACE_NOW,
    });
    const token = await mintGatewayToken(signer, TRACE_NOW);
    const caller = await auth.authenticate({ authorization: `Bearer ${token}` });
    expect(caller.subject).toBe('gateway');
    expect(caller).not.toHaveProperty('workspaceId');
    expect(LLM_AUDIENCE).toBe('proba-llm');
  });
});
