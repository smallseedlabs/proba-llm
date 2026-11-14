import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  NODE_ENV: 'test',
  LLM_BASE_URL: 'https://api.deepseek.com',
  LLM_MODEL: 'deepseek-chat',
  LLM_ALLOWED_HOSTS: 'api.deepseek.com',
  LLM_ALLOWED_MODELS: 'deepseek-chat',
};

describe('pricingFromEnv', () => {
  it('leaves all unit prices unset when the PRICE_* variables are omitted', () => {
    const pricing = loadConfig(base).pricing;
    expect(pricing).toEqual({
      version: null,
      promptUsdPerMillion: null,
      completionUsdPerMillion: null,
      promptCacheHitUsdPerMillion: null,
    });
  });

  it('derives env:<prompt>/<completion> when only the original two rates are set', () => {
    const pricing = loadConfig({ ...base, PRICE_PROMPT_USD_PER_MILLION: '0.3', PRICE_COMPLETION_USD_PER_MILLION: '1.2' }).pricing;
    expect(pricing).toEqual({
      version: 'env:0.3/1.2',
      promptUsdPerMillion: 0.3,
      completionUsdPerMillion: 1.2,
      promptCacheHitUsdPerMillion: null,
    });
  });

  it('includes the cache-hit rate in the derived version when it is set', () => {
    const pricing = loadConfig({
      ...base,
      PRICE_PROMPT_USD_PER_MILLION: '0.3',
      PRICE_COMPLETION_USD_PER_MILLION: '1.2',
      PRICE_PROMPT_CACHE_HIT_USD_PER_MILLION: '0.006',
    }).pricing;
    expect(pricing).toEqual({
      version: 'env:0.3/1.2/hit:0.006',
      promptUsdPerMillion: 0.3,
      completionUsdPerMillion: 1.2,
      promptCacheHitUsdPerMillion: 0.006,
    });
  });

  it('keeps an explicit PRICING_VERSION ahead of the derived name', () => {
    const pricing = loadConfig({
      ...base,
      PRICE_PROMPT_USD_PER_MILLION: '0.3',
      PRICE_COMPLETION_USD_PER_MILLION: '1.2',
      PRICE_PROMPT_CACHE_HIT_USD_PER_MILLION: '0.006',
      PRICING_VERSION: 'deepseek-flash-peak-2026-11',
    }).pricing;
    expect(pricing.version).toBe('deepseek-flash-peak-2026-11');
    expect(pricing.promptCacheHitUsdPerMillion).toBe(0.006);
  });
});
