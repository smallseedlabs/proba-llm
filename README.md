# proba-llm

Internal one-turn model service. Hub calls **gateway**; gateway owns context,
loops and guarded tools; this process performs **one model turn** (text or
tool-call *proposals*). Tools are not executed here.

Caller identity is a short-lived EdDSA service token (`iss` allowlist, default
`proba-gateway`; `aud` `proba-llm`). There is no public ingress default.

Audit events use the protocol `AuditEvent` envelope and `traceId`, published to
the existing `proba.audit.events` stream. Full redacted prompt/response bodies
are stored in `content` (chunked to the protocol cap); the consumer persists
them with ZSTD. A local turn outbox (`TURN_STORE_DIR`) keeps outcomes across
Redis outages so a retried `Idempotency-Key` / `traceId` never pays twice.
Replay of the audit stream must not call the provider.

## Local

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

Configure via `.env.example`. Secrets belong in `*_FILE` mounts, not source.
`FakeLlmProvider` is test-only.
