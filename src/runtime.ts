/**
 * Runtime wiring. Mock/scripted providers are not registered.
 * Test doubles may be injected only when NODE_ENV=test.
 */

import type { JWTVerifyGetKey } from 'jose';
import { ConfigError } from './errors.js';
import { loadPublicKeySet } from './auth/public-key-set.js';
import { ServiceTokenAuth } from './auth/service-token.js';
import { DeepSeekProvider, deepSeekOptionsFromConfig } from './adapters/deepseek.js';
import { LogAuditPublisher, RedisAuditPublisher } from './adapters/audit-redis.js';
import { FileTurnStore } from './adapters/file-turn-store.js';
import { MemoryTurnStore } from './adapters/memory-turn-store.js';
import { SystemClock } from './adapters/system-clock.js';
import { SingleTurnHandler } from './handler/single-turn.js';
import { createLogger, type Logger } from './logger.js';
import type { AuditPublisher } from './ports/audit-publisher.js';
import type { Clock } from './ports/clock.js';
import type { LlmProvider } from './ports/provider.js';
import type { ServiceAuth } from './ports/auth.js';
import type { TurnStore } from './ports/turn-store.js';
import type { LlmServiceConfig } from './types/config.js';

export interface RuntimeOverrides {
  provider?: LlmProvider;
  audit?: AuditPublisher;
  clock?: Clock;
  auth?: ServiceAuth;
  keys?: JWTVerifyGetKey;
  fetch?: typeof fetch;
  logger?: Logger;
  turns?: TurnStore;
}

export interface LlmRuntime {
  config: LlmServiceConfig;
  handler: SingleTurnHandler;
  auth: ServiceAuth;
  audit: AuditPublisher;
  clock: Clock;
  logger: Logger;
  provider: LlmProvider;
  turns: TurnStore;
  ready(): Promise<Record<string, 'ok' | 'fail'>>;
  close(): Promise<void>;
}

export async function createRuntime(config: LlmServiceConfig, overrides: RuntimeOverrides = {}): Promise<LlmRuntime> {
  if (config.provider !== 'deepseek') {
    throw new ConfigError(`provider ${String(config.provider)} is not a runtime provider`);
  }
  if (overrides.provider && config.env === 'production') {
    throw new ConfigError('provider overrides are not allowed when NODE_ENV=production');
  }
  if (overrides.provider && overrides.provider.name === 'fake' && config.env !== 'test') {
    throw new ConfigError('FakeLlmProvider is test-only');
  }

  const clock = overrides.clock ?? new SystemClock();
  const logger = overrides.logger ?? createLogger(config.logLevel);

  let audit = overrides.audit;
  if (!audit) {
    if (config.audit.kind === 'log') {
      audit = new LogAuditPublisher(undefined, config.env);
    } else {
      audit = new RedisAuditPublisher({
        url: config.audit.redisUrl,
        clock,
        stream: config.audit.stream,
        maxStreamLength: config.audit.maxStreamLength,
      });
    }
  }

  let auth = overrides.auth;
  if (!auth) {
    const keys =
      overrides.keys ??
      (await loadPublicKeySet(config.auth.publicKeyFile, { envName: 'GATEWAY_SERVICE_PUBLIC_KEY_FILE', nodeEnv: config.env }))
        .keys;
    auth = new ServiceTokenAuth({
      keys,
      allowedIssuers: config.auth.allowedIssuers,
      allowedSubjects: config.auth.allowedSubjects,
      now: () => clock.now(),
    });
  }

  const provider =
    overrides.provider ??
    new DeepSeekProvider({ ...deepSeekOptionsFromConfig(config, overrides.fetch) });
  if (provider.name === 'fake' && config.env !== 'test') {
    throw new ConfigError('FakeLlmProvider is test-only');
  }

  const turns =
    overrides.turns ??
    (config.turnStoreDir ? new FileTurnStore(config.turnStoreDir) : new MemoryTurnStore());
  const handler = new SingleTurnHandler({ provider, audit, clock, config, turns });

  return {
    config,
    handler,
    auth,
    audit,
    clock,
    logger,
    provider,
    turns,
    async ready() {
      const checks: Record<string, 'ok' | 'fail'> = { config: 'ok' };
      try {
        await provider.ping();
        checks.provider = 'ok';
      } catch {
        checks.provider = 'fail';
      }
      try {
        if (audit.ping) await audit.ping();
        checks.audit = 'ok';
      } catch {
        checks.audit = 'fail';
      }
      try {
        await handler.relayPending();
        checks.outbox = 'ok';
      } catch {
        checks.outbox = 'fail';
      }
      return checks;
    },
    async close() {
      await provider.close();
      await audit.close?.();
      await turns.close();
    },
  };
}
