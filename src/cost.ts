/**
 * Cost estimate from operator-configured PRICE_* rates and one-turn usage.
 * Unit prices are never invented here; when they are unset the estimate is `unknown`.
 *
 * Cache-aware bill (only when PRICE_PROMPT_CACHE_HIT_USD_PER_MILLION is set and
 * the provider returned cache hit and/or miss counts):
 *   hit tokens × hit rate + miss tokens × PRICE_PROMPT_USD_PER_MILLION + output × completion rate.
 * Otherwise every prompt token is charged at PRICE_PROMPT_USD_PER_MILLION (existing behaviour).
 * Miss tokens, when omitted, are derived as promptTokens − cachedTokens (and vice versa).
 */

import type { LlmUsage } from './ports/provider.js';
import type { PricingConfig } from './types/config.js';
import type { CostEstimate } from './types/turn.js';

const MILLION = 1_000_000;

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Cache-hit and cache-miss prompt tokens when the provider reported either field. */
export function cacheSplit(usage: LlmUsage | undefined): { hit: number; miss: number } | undefined {
  if (!usage || !finiteNumber(usage.promptTokens)) return undefined;
  if (finiteNumber(usage.cachedTokens) && finiteNumber(usage.cacheMissTokens)) {
    if (usage.cachedTokens < 0 || usage.cacheMissTokens < 0) return undefined;
    return { hit: usage.cachedTokens, miss: usage.cacheMissTokens };
  }
  if (finiteNumber(usage.cachedTokens)) {
    const miss = usage.promptTokens - usage.cachedTokens;
    if (miss < 0) return undefined;
    return { hit: usage.cachedTokens, miss };
  }
  if (finiteNumber(usage.cacheMissTokens)) {
    const hit = usage.promptTokens - usage.cacheMissTokens;
    if (hit < 0) return undefined;
    return { hit, miss: usage.cacheMissTokens };
  }
  return undefined;
}

export function costOf(usage: LlmUsage | undefined, pricing: PricingConfig): CostEstimate {
  if (
    !pricing.version ||
    pricing.promptUsdPerMillion === null ||
    pricing.completionUsdPerMillion === null ||
    !finiteNumber(usage?.promptTokens) ||
    !finiteNumber(usage?.completionTokens)
  ) {
    return { estimate: 'unknown' };
  }

  const split = pricing.promptCacheHitUsdPerMillion !== null ? cacheSplit(usage) : undefined;
  const promptCost = split
    ? (split.hit / MILLION) * pricing.promptCacheHitUsdPerMillion! +
      (split.miss / MILLION) * pricing.promptUsdPerMillion
    : (usage.promptTokens / MILLION) * pricing.promptUsdPerMillion;
  const amount = promptCost + (usage.completionTokens / MILLION) * pricing.completionUsdPerMillion;
  if (!Number.isFinite(amount) || amount < 0) return { estimate: 'unknown' };
  return { estimate: amount, currency: 'USD', pricingVersion: pricing.version };
}
