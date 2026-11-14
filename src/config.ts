import { readFileSync } from 'node:fs';
import { ConfigError } from './errors.js';
import { DEFAULT_CALLER_ISSUERS, DEFAULT_CALLER_SUBJECTS } from './auth/constants.js';
import type { AuditPublisherKind, LlmServiceConfig, RuntimeEnv } from './types/config.js';

function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(raw);
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function envNumber(env: NodeJS.ProcessEnv, name: string): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new ConfigError(`${name} must be a non-negative number`);
  return parsed;
}

function envList(env: NodeJS.ProcessEnv, name: string, fallback: readonly string[]): string[] {
  const raw = env[name]?.trim();
  if (!raw) return [...fallback];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function envSecret(env: NodeJS.ProcessEnv, name: string): string {
  const filePath = env[`${name}_FILE`]?.trim();
  if (filePath) {
    try {
      return readFileSync(filePath, 'utf8').trim();
    } catch (err) {
      throw new ConfigError(`${name}_FILE is set but could not be read (${filePath}): ${(err as Error).message}`);
    }
  }
  return (env[name] ?? '').trim();
}

function thinkingMode(raw: string | undefined): 'enabled' | 'disabled' {
  const value = (raw ?? 'disabled').trim().toLowerCase();
  if (value === 'enabled' || value === 'disabled') return value;
  throw new ConfigError('LLM_THINKING must be enabled or disabled');
}

function runtimeEnv(raw: string | undefined): RuntimeEnv {
  const value = (raw ?? 'development').trim().toLowerCase();
  if (value === 'development' || value === 'test' || value === 'production') return value;
  throw new ConfigError(`NODE_ENV must be development, test or production (got "${raw}")`);
}

/**
 * Load config from the environment. Secrets come from `NAME_FILE` (Swarm/GCP mount)
 * or `NAME`. Values are never returned in logs by the caller.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LlmServiceConfig {
  const nodeEnv = runtimeEnv(env.NODE_ENV);
  const providerRaw = (env.LLM_PROVIDER ?? 'deepseek').trim().toLowerCase();
  if (providerRaw !== 'deepseek') {
    throw new ConfigError(`LLM_PROVIDER must be deepseek (mock/scripted are test-only; got "${providerRaw}")`);
  }

  const baseUrl = (env.LLM_BASE_URL ?? '').trim();
  const model = (env.LLM_MODEL ?? '').trim();
  const allowedHosts = envList(env, 'LLM_ALLOWED_HOSTS', []);
  const allowedModels = envList(env, 'LLM_ALLOWED_MODELS', model ? [model] : []);
  const apiKey = envSecret(env, 'LLM_API_KEY');
  const publisherRaw = (env.AUDIT_PUBLISHER ?? (nodeEnv === 'production' ? 'redis' : 'log')).trim().toLowerCase();
  if (publisherRaw !== 'redis' && publisherRaw !== 'log') {
    throw new ConfigError(`AUDIT_PUBLISHER must be redis or log (got "${publisherRaw}")`);
  }
  const auditKind = publisherRaw as AuditPublisherKind;
  if (nodeEnv === 'production' && auditKind === 'log') {
    throw new ConfigError('AUDIT_PUBLISHER=log is not allowed when NODE_ENV=production');
  }

  const publicKeyFile = (env.GATEWAY_SERVICE_PUBLIC_KEY_FILE ?? '').trim();
  const redisUrl = envSecret(env, 'REDIS_URL') || (env.REDIS_URL ?? '').trim();

  if (nodeEnv === 'production') {
    if (!baseUrl) throw new ConfigError('LLM_BASE_URL is required when NODE_ENV=production');
    if (!model) throw new ConfigError('LLM_MODEL is required when NODE_ENV=production');
    if (allowedHosts.length === 0) throw new ConfigError('LLM_ALLOWED_HOSTS is required when NODE_ENV=production');
    if (allowedModels.length === 0) throw new ConfigError('LLM_ALLOWED_MODELS or LLM_MODEL is required when NODE_ENV=production');
    if (!apiKey) throw new ConfigError('LLM_API_KEY or LLM_API_KEY_FILE is required when NODE_ENV=production');
    if (!publicKeyFile) throw new ConfigError('GATEWAY_SERVICE_PUBLIC_KEY_FILE is required when NODE_ENV=production');
    if (auditKind === 'redis' && !redisUrl) throw new ConfigError('REDIS_URL or REDIS_URL_FILE is required when AUDIT_PUBLISHER=redis');
  }

  const turnStoreDir = (env.TURN_STORE_DIR ?? (nodeEnv === 'test' ? '' : 'data/turns')).trim();
  if (nodeEnv === 'production' && !turnStoreDir) {
    throw new ConfigError('TURN_STORE_DIR is required when NODE_ENV=production');
  }

  if (env.INGRESS_PUBLIC?.trim() === 'true') {
    throw new ConfigError('INGRESS_PUBLIC=true is refused: proba-llm is an internal service with no public ingress default');
  }

  const host = (env.HOST ?? (nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1')).trim();
  const port = envInt(env, 'PORT', 3600, 1, 65535);

  return {
    env: nodeEnv,
    logLevel: (env.LOG_LEVEL ?? 'info').trim() || 'info',
    provider: 'deepseek',
    deepseek: {
      baseUrl,
      model,
      timeoutMs: envInt(env, 'LLM_TIMEOUT_MS', 60_000, 100, 300_000),
      maxRetries: envInt(env, 'LLM_MAX_RETRIES', 1, 0, 4),
      totalBudgetMs: envInt(env, 'LLM_TOTAL_BUDGET_MS', 90_000, 100, 600_000),
      temperature: envNumber(env, 'LLM_TEMPERATURE') ?? 0,
      thinking: thinkingMode(env.LLM_THINKING),
      apiKey,
    },
    allowedHosts,
    allowedModels,
    listen: { host, port },
    auth: {
      publicKeyFile,
      allowedIssuers: envList(env, 'CALLER_ISSUERS', DEFAULT_CALLER_ISSUERS),
      allowedSubjects: envList(env, 'CALLER_SUBJECTS', DEFAULT_CALLER_SUBJECTS),
    },
    limits: {
      maxRequestBytes: envInt(env, 'LLM_MAX_REQUEST_BYTES', 262_144, 1024, 2_000_000),
      maxMessages: envInt(env, 'LLM_MAX_MESSAGES', 64, 1, 256),
      maxMessageChars: envInt(env, 'LLM_MAX_MESSAGE_CHARS', 32_768, 256, 200_000),
      maxTokens: envInt(env, 'LLM_MAX_TOKENS', 4096, 16, 128_000),
      maxTools: envInt(env, 'LLM_MAX_TOOLS', 16, 0, 64),
      rateLimitMax: envInt(env, 'RATE_LIMIT_MAX', 60, 1, 10_000),
      rateLimitWindowMs: envInt(env, 'RATE_LIMIT_WINDOW_MS', 60_000, 1000, 3_600_000),
    },
    pricing: pricingFromEnv(env),
    audit: {
      kind: auditKind,
      stream: (env.AUDIT_STREAM ?? 'proba.audit.events').trim() || 'proba.audit.events',
      redisUrl,
      contentEnabled: envBool(env, 'AUDIT_CONTENT_ENABLED', true),
      contentMaskPii: envBool(env, 'AUDIT_CONTENT_MASK_PII', true),
      maxStreamLength: envInt(env, 'AUDIT_STREAM_MAXLEN', 0, 0, 100_000_000),
    },
    turnStoreDir,
  };
}

/**
 * Unit prices come only from the operator's PRICE_* values. When prompt and completion
 * rates are set without PRICING_VERSION, the version names that price table
 * (`env:<prompt>/<completion>` or `env:<prompt>/<completion>/hit:<hit>`) so a cost
 * estimate is still attributable. The cache-hit rate is optional and never inferred.
 */
function pricingFromEnv(env: NodeJS.ProcessEnv): LlmServiceConfig['pricing'] {
  const promptUsdPerMillion = envNumber(env, 'PRICE_PROMPT_USD_PER_MILLION');
  const completionUsdPerMillion = envNumber(env, 'PRICE_COMPLETION_USD_PER_MILLION');
  const promptCacheHitUsdPerMillion = envNumber(env, 'PRICE_PROMPT_CACHE_HIT_USD_PER_MILLION');
  const explicit = env.PRICING_VERSION?.trim() || null;
  const derived =
    promptUsdPerMillion !== null && completionUsdPerMillion !== null
      ? promptCacheHitUsdPerMillion !== null
        ? `env:${promptUsdPerMillion}/${completionUsdPerMillion}/hit:${promptCacheHitUsdPerMillion}`
        : `env:${promptUsdPerMillion}/${completionUsdPerMillion}`
      : null;
  return { version: explicit ?? derived, promptUsdPerMillion, completionUsdPerMillion, promptCacheHitUsdPerMillion };
}
