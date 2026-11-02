import "server-only";

export type UsagePriceCategory =
  | "chat"
  | "image"
  | "speech"
  | "transcribe"
  | "realtime";
export interface UsagePrice {
  model: string;
  category: UsagePriceCategory;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  perMinute: number | null;
}

export const USAGE_PRICE_VERSION = "2026-11-03";
export const USAGE_PRICE_SOURCE =
  "https://developers.openai.com/api/docs/pricing";

const tokens = (
  model: string,
  category: UsagePriceCategory,
  inputPerMillion: number,
  outputPerMillion: number,
): Readonly<UsagePrice> =>
  Object.freeze({
    model,
    category,
    inputPerMillion,
    outputPerMillion,
    perMinute: null,
  });

/**
 * USD standard, short-context, uncached public rates verified on the version date.
 * Older chat models: https://developers.openai.com/api/docs/models/{model}
 * Image rows use text input and image output because this site's image endpoint
 * currently generates from text only. Realtime aggregate ledgers use audio rates;
 * speech uses text input and audio output. No discounts or account credits applied.
 */
export const USAGE_PRICEBOOK: readonly Readonly<UsagePrice>[] = Object.freeze([
  tokens("gpt-4o-mini", "chat", 0.15, 0.6),
  tokens("gpt-4.1-nano", "chat", 0.1, 0.4),
  tokens("gpt-4.1-mini", "chat", 0.4, 1.6),
  tokens("gpt-4.1", "chat", 2, 8),
  tokens("gpt-4o", "chat", 2.5, 10),
  tokens("gpt-5.4-mini", "chat", 0.75, 4.5),
  tokens("gpt-6-luna", "chat", 0.1, 0.5),
  tokens("gpt-6.1-terra", "chat", 1, 5),
  tokens("gpt-6.1-sol", "chat", 2, 10),
  tokens("gpt-6-astra", "chat", 10, 50),
  tokens("gpt-image-2.5-flare", "image", 5, 30),
  tokens("gpt-image-2.5-sunburst", "image", 5, 30),
  tokens("gpt-image-1.5", "image", 5, 32),
  tokens("gpt-image-1-mini", "image", 2, 8),
  tokens("gpt-realtime-2.1-mini", "speech", 0.6, 20),
  tokens("gpt-realtime-2.1-mini", "realtime", 10, 20),
  Object.freeze({
    model: "gpt-transcribe",
    category: "transcribe",
    inputPerMillion: null,
    outputPerMillion: null,
    perMinute: 0.0045,
  }),
  tokens("gpt-4o-mini-transcribe", "transcribe", 1.25, 5),
  tokens("gpt-4o-transcribe", "transcribe", 2.5, 10),
]);

/** Only exact known aliases and genuine YYYY-MM-DD snapshots share a rate. */
export function normalizedPriceModel(model: unknown): string | null {
  if (typeof model !== "string" || !model || model.length > 128) return null;
  const match = /^(.*)-(\d{4}-\d{2}-\d{2})$/.exec(model);
  if (!match) return model;
  const date = new Date(`${match[2]}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === match[2]
    ? match[1]
    : null;
}

export function usagePrice(
  model: unknown,
  category: UsagePriceCategory,
): Readonly<UsagePrice> | null {
  const normalized = normalizedPriceModel(model);
  return (
    USAGE_PRICEBOOK.find(
      (row) => row.model === normalized && row.category === category,
    ) ?? null
  );
}

export interface UsageCostInput {
  model: unknown;
  category: UsagePriceCategory;
  source: "reported" | "unknown";
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Canonical measured duration for duration-billed transcription. */
  audioSeconds?: number | null;
}

/** Null means unpriced/unknown, which must not become a known zero charge. */
export function estimateUsageCost(event: UsageCostInput): number | null {
  const price = usagePrice(event.model, event.category);
  if (!price) return null;
  if (price.perMinute !== null) {
    if (
      typeof event.audioSeconds !== "number" ||
      !Number.isFinite(event.audioSeconds) ||
      event.audioSeconds < 0
    )
      return null;
    const total = (event.audioSeconds / 60) * price.perMinute;
    return Number.isFinite(total) && total >= 0 ? total : null;
  }
  if (
    event.source !== "reported" ||
    !Number.isSafeInteger(event.inputTokens) ||
    !Number.isSafeInteger(event.outputTokens) ||
    Number(event.inputTokens) < 0 ||
    Number(event.outputTokens) < 0 ||
    price.inputPerMillion === null ||
    price.outputPerMillion === null
  )
    return null;
  const total =
    (Number(event.inputTokens) / 1_000_000) * price.inputPerMillion +
    (Number(event.outputTokens) / 1_000_000) * price.outputPerMillion;
  return Number.isFinite(total) && total >= 0 ? total : null;
}
