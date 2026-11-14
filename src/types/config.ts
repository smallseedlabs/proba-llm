export const LLM_SERVICE_NAME = 'llm';

export type RuntimeEnv = 'development' | 'test' | 'production';

export type LlmProviderKind = 'deepseek';

export type ThinkingMode = 'enabled' | 'disabled';

export type AuditPublisherKind = 'redis' | 'log';

export interface DeepSeekConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  totalBudgetMs: number;
  temperature: number;
  thinking: ThinkingMode;
  apiKey: string;
}

export interface ListenConfig {
  host: string;
  port: number;
}

export interface AuthConfig {
  publicKeyFile: string;
  allowedIssuers: readonly string[];
  allowedSubjects: readonly string[];
}

export interface LimitsConfig {
  maxRequestBytes: number;
  maxMessages: number;
  maxMessageChars: number;
  maxTokens: number;
  maxTools: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
}

export interface PricingConfig {
  version: string | null;
  promptUsdPerMillion: number | null;
  completionUsdPerMillion: number | null;
  /** Cache-hit input rate. Null means charge every prompt token at promptUsdPerMillion. */
  promptCacheHitUsdPerMillion: number | null;
}

export interface AuditConfig {
  kind: AuditPublisherKind;
  stream: string;
  redisUrl: string;
  contentEnabled: boolean;
  contentMaskPii: boolean;
  maxStreamLength: number;
}

export interface LlmServiceConfig {
  env: RuntimeEnv;
  logLevel: string;
  provider: LlmProviderKind;
  deepseek: DeepSeekConfig;
  allowedHosts: readonly string[];
  allowedModels: readonly string[];
  listen: ListenConfig;
  auth: AuthConfig;
  limits: LimitsConfig;
  pricing: PricingConfig;
  audit: AuditConfig;
  turnStoreDir: string;
}
