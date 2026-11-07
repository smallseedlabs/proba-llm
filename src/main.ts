/**
 * Process entry. Internal HTTP only. Hub calls gateway; this is one model turn.
 */

import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';
import { buildApp } from './http/app.js';
import { ConfigError } from './errors.js';
import { buildAuditEvent, getAuditActionInfo } from './protocol.js';
import { LLM_SERVICE_NAME } from './types/config.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const runtime = await createRuntime(config);
  const app = await buildApp({
    config,
    handler: runtime.handler,
    auth: runtime.auth,
    audit: runtime.audit,
    clock: runtime.clock,
    logger: runtime.logger,
    ready: () => runtime.ready(),
  });

  const started = getAuditActionInfo('system.started');
  await runtime.audit.publish(
    buildAuditEvent({
      traceId: '00000000-0000-4000-8000-000000000001',
      workspaceId: 'seedbed',
      actor: { type: 'service', id: LLM_SERVICE_NAME },
      service: LLM_SERVICE_NAME,
      action: 'system.started',
      category: started?.category ?? 'system',
      outcome: 'success',
      occurredAt: runtime.clock.isoNow(),
      details: { env: config.env, provider: config.provider, listen: `${config.listen.host}:${config.listen.port}` },
    })
  );

  await runtime.handler.relayPending();
  const relay = setInterval(() => {
    void runtime.handler.relayPending();
  }, 2000);
  relay.unref();

  await app.listen({ port: config.listen.port, host: config.listen.host });
  runtime.logger.info({ port: config.listen.port, host: config.listen.host }, 'proba-llm listening');

  const shutdown = async (signal: string) => {
    runtime.logger.info({ signal }, 'shutting down');
    const stopped = getAuditActionInfo('system.stopped');
    try {
      await runtime.audit.publish(
        buildAuditEvent({
          traceId: '00000000-0000-4000-8000-000000000002',
          workspaceId: 'seedbed',
          actor: { type: 'service', id: LLM_SERVICE_NAME },
          service: LLM_SERVICE_NAME,
          action: 'system.stopped',
          category: stopped?.category ?? 'system',
          outcome: 'success',
          occurredAt: runtime.clock.isoNow(),
          details: { signal },
        })
      );
    } catch {
      // best-effort
    }
    clearInterval(relay);
    await app.close();
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  const message = err instanceof ConfigError ? err.message : err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
