import { describe, expect, it } from 'vitest';
import { cacheSplit, costOf } from './cost.js';
import type { PricingConfig } from './types/config.js';

/** Official deepseek-flash peak rates (USD / 1M tokens), verified 2026-11-14 from https://api-docs.deepseek.com/quick_start/pricing/ */
const FLASH_PEAK: PricingConfig = {
  version: 'env:0.3/1.2/hit:0.006',
  promptUsdPerMillion: 0.3,
  completionUsdPerMillion: 1.2,
  promptCacheHitUsdPerMillion: 0.006,
};

const FLASH_PEAK_NO_HIT: PricingConfig = {
  version: 'env:0.3/1.2',
  promptUsdPerMillion: 0.3,
  completionUsdPerMillion: 1.2,
  promptCacheHitUsdPerMillion: null,
};

const FLASH_OFF_PEAK: PricingConfig = {
  version: 'env:0.15/0.6/hit:0.003',
  promptUsdPerMillion: 0.15,
  completionUsdPerMillion: 0.6,
  promptCacheHitUsdPerMillion: 0.003,
};

describe('cacheSplit', () => {
  it('is undefined when the provider omitted both cache fields', () => {
    expect(cacheSplit({ promptTokens: 10, completionTokens: 1 })).toBeUndefined();
    expect(cacheSplit(undefined)).toBeUndefined();
  });

  it('uses both fields when the provider sent them', () => {
    expect(cacheSplit({ promptTokens: 10, cachedTokens: 7, cacheMissTokens: 3 })).toEqual({ hit: 7, miss: 3 });
  });

  it('derives miss from prompt − hit, and hit from prompt − miss', () => {
    expect(cacheSplit({ promptTokens: 10, cachedTokens: 4 })).toEqual({ hit: 4, miss: 6 });
    expect(cacheSplit({ promptTokens: 10, cacheMissTokens: 3 })).toEqual({ hit: 7, miss: 3 });
  });

  it('is undefined when a derived side would be negative', () => {
    expect(cacheSplit({ promptTokens: 10, cachedTokens: 12 })).toBeUndefined();
    expect(cacheSplit({ promptTokens: 10, cacheMissTokens: 12 })).toBeUndefined();
  });
});

describe('costOf', () => {
  it('is unknown when unit prices or token counts are missing', () => {
    expect(costOf({ promptTokens: 10, completionTokens: 2 }, { ...FLASH_PEAK, promptUsdPerMillion: null })).toEqual({
      estimate: 'unknown',
    });
    expect(costOf({ completionTokens: 2 }, FLASH_PEAK)).toEqual({ estimate: 'unknown' });
    expect(costOf(undefined, FLASH_PEAK)).toEqual({ estimate: 'unknown' });
  });

  it('charges every prompt token at the full input rate when no cache-hit rate is set', () => {
    const usage = { promptTokens: 1_000, completionTokens: 50, cachedTokens: 800, cacheMissTokens: 200 };
    expect(costOf(usage, FLASH_PEAK_NO_HIT)).toEqual({
      estimate: (1_000 / 1_000_000) * 0.3 + (50 / 1_000_000) * 1.2,
      currency: 'USD',
      pricingVersion: 'env:0.3/1.2',
    });
  });

  it('charges every prompt token at the full input rate when a hit rate is set but the provider sent no cache fields', () => {
    const usage = { promptTokens: 1_000, completionTokens: 50 };
    expect(costOf(usage, FLASH_PEAK).estimate).toBe((1_000 / 1_000_000) * 0.3 + (50 / 1_000_000) * 1.2);
  });

  it('bills hit × hit rate + miss × miss rate + output × output rate', () => {
    const usage = { promptTokens: 1_000, completionTokens: 50, cachedTokens: 800, cacheMissTokens: 200 };
    const expected = (800 / 1_000_000) * 0.006 + (200 / 1_000_000) * 0.3 + (50 / 1_000_000) * 1.2;
    expect(costOf(usage, FLASH_PEAK).estimate).toBeCloseTo(expected, 12);
    expect(costOf(usage, FLASH_PEAK)).toMatchObject({ currency: 'USD', pricingVersion: FLASH_PEAK.version });
  });

  it('derives the missing cache side before billing', () => {
    const withHitOnly = { promptTokens: 1_000, completionTokens: 50, cachedTokens: 800 };
    const withMissOnly = { promptTokens: 1_000, completionTokens: 50, cacheMissTokens: 200 };
    const expected = (800 / 1_000_000) * 0.006 + (200 / 1_000_000) * 0.3 + (50 / 1_000_000) * 1.2;
    expect(costOf(withHitOnly, FLASH_PEAK).estimate).toBeCloseTo(expected, 12);
    expect(costOf(withMissOnly, FLASH_PEAK).estimate).toBeCloseTo(expected, 12);
  });

  it('treats an explicit zero cache hit as a cache-aware miss of the whole prompt', () => {
    const usage = { promptTokens: 1_000, completionTokens: 50, cachedTokens: 0, cacheMissTokens: 1_000 };
    expect(costOf(usage, FLASH_PEAK).estimate).toBeCloseTo((1_000 / 1_000_000) * 0.3 + (50 / 1_000_000) * 1.2, 12);
  });

  it('falls back to the full prompt rate when cache fields are inconsistent', () => {
    const usage = { promptTokens: 10, completionTokens: 1, cachedTokens: 12 };
    expect(costOf(usage, FLASH_PEAK).estimate).toBe((10 / 1_000_000) * 0.3 + (1 / 1_000_000) * 1.2);
  });

  it('accepts a configured hit rate of 0 (cache hits are free)', () => {
    const pricing: PricingConfig = { ...FLASH_PEAK, promptCacheHitUsdPerMillion: 0, version: 'env:0.3/1.2/hit:0' };
    const usage = { promptTokens: 1_000, completionTokens: 0, cachedTokens: 1_000, cacheMissTokens: 0 };
    expect(costOf(usage, pricing).estimate).toBe(0);
  });

  it('matches the official deepseek-flash peak bill on a 90% cache-hit prompt', () => {
    // 900k hit, 100k miss, 10k output at peak 0.006 / 0.30 / 1.20 per 1M tokens.
    const usage = { promptTokens: 1_000_000, completionTokens: 10_000, cachedTokens: 900_000, cacheMissTokens: 100_000 };
    expect(costOf(usage, FLASH_PEAK).estimate).toBeCloseTo(0.0054 + 0.03 + 0.012, 12);
    expect(costOf(usage, FLASH_OFF_PEAK).estimate).toBeCloseTo(0.0027 + 0.015 + 0.006, 12);
    expect(costOf(usage, FLASH_PEAK_NO_HIT).estimate).toBeCloseTo(0.3 + 0.012, 12);
  });
});
