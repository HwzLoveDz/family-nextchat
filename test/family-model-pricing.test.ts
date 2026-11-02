/** @jest-environment node */
import { jest } from "@jest/globals";
jest.unstable_mockModule("server-only", () => ({}));
const {
  estimateUsageCost,
  normalizedPriceModel,
  usagePrice,
  USAGE_PRICEBOOK,
  USAGE_PRICE_VERSION,
  USAGE_PRICE_SOURCE,
} = await import("@/app/family/server/model-pricing");

test("rate book has unique model/category identities and JSON-safe positive documented rates", () => {
  expect(USAGE_PRICE_VERSION).toBe("2026-11-03");
  expect(USAGE_PRICE_SOURCE).toBe(
    "https://developers.openai.com/api/docs/pricing",
  );
  expect(USAGE_PRICEBOOK).toHaveLength(19);
  expect(
    new Set(USAGE_PRICEBOOK.map((row) => `${row.category}:${row.model}`)).size,
  ).toBe(USAGE_PRICEBOOK.length);
  for (const row of USAGE_PRICEBOOK) {
    expect(Object.isFrozen(row)).toBe(true);
    for (const rate of [
      row.inputPerMillion,
      row.outputPerMillion,
      row.perMinute,
    ])
      if (rate !== null) expect(Number.isFinite(rate) && rate > 0).toBe(true);
    expect(
      (row.perMinute === null) !==
        (row.inputPerMillion === null && row.outputPerMillion === null),
    ).toBe(true);
  }
  expect(JSON.parse(JSON.stringify(USAGE_PRICEBOOK))).toEqual(USAGE_PRICEBOOK);
});

test("standard flagship rates are not the Batch half-price rows", () => {
  expect(usagePrice("gpt-6-astra", "chat")).toMatchObject({
    inputPerMillion: 10,
    outputPerMillion: 50,
  });
  expect(usagePrice("gpt-6.1-sol", "chat")).toMatchObject({
    inputPerMillion: 2,
    outputPerMillion: 10,
  });
  expect(usagePrice("gpt-6.1-terra", "chat")).toMatchObject({
    inputPerMillion: 1,
    outputPerMillion: 5,
  });
  expect(usagePrice("gpt-6-luna", "chat")).toMatchObject({
    inputPerMillion: 0.1,
    outputPerMillion: 0.5,
  });
});

test("model snapshots use the known alias without fuzzily matching a different model", () => {
  expect(normalizedPriceModel("gpt-image-2.5-flare-2026-09-08")).toBe(
    "gpt-image-2.5-flare",
  );
  expect(usagePrice("gpt-4o-mini-2024-07-18", "chat")).toEqual(
    usagePrice("gpt-4o-mini", "chat"),
  );
  expect(usagePrice("gpt-6.1-sol-custom", "chat")).toBeNull();
  expect(usagePrice("gpt-6.1-sol-2026-02-30", "chat")).toBeNull();
  expect(usagePrice("unknown-2026-01-01", "chat")).toBeNull();
});

test("the same realtime model uses different explicit rates for read-aloud and calls", () => {
  expect(
    estimateUsageCost({
      model: "gpt-realtime-2.1-mini",
      category: "speech",
      source: "reported",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }),
  ).toBeCloseTo(20.6, 10);
  expect(
    estimateUsageCost({
      model: "gpt-realtime-2.1-mini",
      category: "realtime",
      source: "reported",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }),
  ).toBe(30);
  expect(usagePrice("gpt-realtime-2.1-mini", "chat")).toBeNull();
});

test("text-only image prompts use text input and image output rates", () => {
  expect(
    estimateUsageCost({
      model: "gpt-image-2.5-flare",
      category: "image",
      source: "reported",
      inputTokens: 1000,
      outputTokens: 1000,
    }),
  ).toBeCloseTo(0.035, 10);
  expect(
    estimateUsageCost({
      model: "gpt-image-1.5",
      category: "image",
      source: "reported",
      inputTokens: 1000,
      outputTokens: 1000,
    }),
  ).toBeCloseTo(0.037, 10);
  expect(
    estimateUsageCost({
      model: "gpt-image-1-mini",
      category: "image",
      source: "reported",
      inputTokens: 1000,
      outputTokens: 1000,
    }),
  ).toBeCloseTo(0.01, 10);
});

test("canonical transcription duration is billed once without adding token rates", () => {
  expect(
    estimateUsageCost({
      model: "gpt-transcribe",
      category: "transcribe",
      source: "unknown",
      audioSeconds: 90,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }),
  ).toBeCloseTo(0.00675, 10);
  expect(
    estimateUsageCost({
      model: "gpt-transcribe",
      category: "transcribe",
      source: "reported",
      audioSeconds: 0,
    }),
  ).toBe(0);
  expect(
    estimateUsageCost({
      model: "gpt-4o-mini-transcribe",
      category: "transcribe",
      source: "reported",
      inputTokens: 1000,
      outputTokens: 1000,
      audioSeconds: 90,
    }),
  ).toBeCloseTo(0.00625, 10);
});

test("real reported zero usage is a known zero, while missing or unknown usage is null", () => {
  const event = {
    model: "gpt-4o-mini",
    category: "chat" as const,
    source: "reported" as const,
    inputTokens: 0,
    outputTokens: 0,
  };
  expect(estimateUsageCost(event)).toBe(0);
  expect(estimateUsageCost({ ...event, source: "unknown" })).toBeNull();
  expect(estimateUsageCost({ ...event, inputTokens: null })).toBeNull();
  expect(estimateUsageCost({ ...event, outputTokens: undefined })).toBeNull();
  expect(estimateUsageCost({ ...event, model: "unpriced-model" })).toBeNull();
});

test.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "invalid token values never produce a known cost (%s)",
  (value) => {
    expect(
      estimateUsageCost({
        model: "gpt-4o-mini",
        category: "chat",
        source: "reported",
        inputTokens: value,
        outputTokens: 1,
      }),
    ).toBeNull();
  },
);

test.each([undefined, null, -1, NaN, Infinity])(
  "invalid/missing audio duration never produces a charge (%s)",
  (value) => {
    expect(
      estimateUsageCost({
        model: "gpt-transcribe",
        category: "transcribe",
        source: "unknown",
        audioSeconds: value,
      }),
    ).toBeNull();
  },
);
