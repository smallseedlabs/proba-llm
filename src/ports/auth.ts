/**
 * Swappable inbound service-auth port.
 *
 * Caller identity comes only from a verified short-lived service token
 * (signature, issuer, audience `proba-llm`, expiry, allowlisted subject).
 * Request headers/body are not a source of caller identity.
 */

export interface IdentityCredentials {
  /** Raw `Authorization` header. */
  authorization?: string;
}

export interface VerifiedCaller {
  issuer: string;
  subject: string;
  jti: string;
  keyId: string;
  expiresAt: Date;
}

/** @deprecated Use VerifiedCaller. Kept as an alias for the skeleton name. */
export type ResolvedIdentity = VerifiedCaller;

export class IdentityRejectedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'IdentityRejectedError';
    this.code = code;
  }
}

export class TokenVerificationError extends IdentityRejectedError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'TokenVerificationError';
  }
}

export interface ServiceAuth {
  readonly name: string;
  authenticate(credentials: IdentityCredentials): Promise<VerifiedCaller>;
}

/** @deprecated Use ServiceAuth. */
export type IdentityResolver = ServiceAuth;
