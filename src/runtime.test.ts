import { describe, expect, it } from 'vitest';
import { createRuntime } from './runtime.js';
import { loadConfig } from './config.js';
import { FakeLlmProvider } from './testing/fake-provider.js';
import { MemoryAuditPublisher } from './testing/memory-audit.js';
import { createTestSigner } from './testing/token-signer.js';

describe('createRuntime', () => {
  it('refuses a fake provider outside test', async () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      LLM_BASE_URL: 'https://api.deepseek.com',
      LLM_MODEL: 'deepseek-chat',
      LLM_ALLOWED_HOSTS: 'api.deepseek.com',
      LLM_API_KEY: 'sk-test',
      GATEWAY_SERVICE_PUBLIC_KEY_FILE: 'unused',
      AUDIT_PUBLISHER: 'log',
    });
    await expect(
      createRuntime(config, { provider: new FakeLlmProvider(), audit: new MemoryAuditPublisher() })
    ).rejects.toThrow(/test-only/);
  });

  it('allows a fake provider in test', async () => {
    const signer = await createTestSigner();
    const config = loadConfig({
      NODE_ENV: 'test',
      LLM_BASE_URL: 'https://api.deepseek.com',
      LLM_MODEL: 'deepseek-chat',
      LLM_ALLOWED_HOSTS: 'api.deepseek.com',
      LLM_ALLOWED_MODELS: 'deepseek-chat,fake-test-model',
      AUDIT_PUBLISHER: 'log',
    });
    const runtime = await createRuntime(config, {
      provider: new FakeLlmProvider(),
      audit: new MemoryAuditPublisher(),
      keys: signer.keys,
    });
    expect(runtime.provider.name).toBe('fake');
    await runtime.close();
  });
});
