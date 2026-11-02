/** @jest-environment node */
import { jest } from "@jest/globals";
import type { UsageDashboardCounters } from "../app/family/usage-dashboard-types";
const query = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("@/app/family/server/db", () => ({
  getPool: () => ({ query }),
}));
const { loadUsageDashboard, usageDashboardRange, USAGE_DASHBOARD_SQL } =
  await import("@/app/family/server/usage-dashboard");
const { USAGE_PRICEBOOK, USAGE_PRICE_VERSION } = await import(
  "@/app/family/server/model-pricing"
);
const now = new Date("2026-11-03T04:00:00.000Z");
const zero = (): UsageDashboardCounters => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  requests: 0,
  reportedRequests: 0,
  unknownRequests: 0,
  runningRequests: 0,
  cost: {
    estimatedUSD: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
    priceVersion: USAGE_PRICE_VERSION,
  },
});
const total = (): UsageDashboardCounters => ({
  inputTokens: 100,
  outputTokens: 200,
  totalTokens: 300,
  requests: 4,
  reportedRequests: 3,
  unknownRequests: 1,
  runningRequests: 1,
  cost: {
    estimatedUSD: 0.05,
    pricedRequests: 3,
    unpricedRequests: 1,
    priceVersion: USAGE_PRICE_VERSION,
  },
});
function payload(days: 7 | 30 | 90 | "all" = 7, self = false) {
  const range = usageDashboardRange(days as 7, now),
    start = new Date(range.firstDate + "T00:00:00Z").getTime();
  return {
    userExists: true,
    members: [
      { id: "owner-a", name: "甲", email: "never-return@test.invalid" },
      ...(self ? [] : [{ id: "owner-b", name: "乙" }]),
    ],
    membersTruncated: false,
    summary: total(),
    daily: Array.from({ length: days === "all" ? 90 : days }, (_, i) => ({
      date: new Date(start + i * 86400000).toISOString().slice(0, 10),
      ...(i ? zero() : total()),
    })),
    models: [
      {
        id: "reported:model-a",
        model: "model-a",
        label: "model-a",
        source: "reported",
        ...total(),
      },
    ],
    people: [{ id: "owner-a", name: "甲", ...total() }],
    secret: "never-return-private",
  };
}
beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [{ payload: payload() }] });
});

test("Beijing natural-day boundaries cross UTC date and month correctly", () => {
  expect(usageDashboardRange(7, new Date("2026-11-03T15:59:59.000Z"))).toEqual({
    from: "2026-10-27T16:00:00.000Z",
    to: "2026-11-03T16:00:00.000Z",
    firstDate: "2026-10-28",
    lastDate: "2026-11-03",
  });
  expect(usageDashboardRange(7, new Date("2026-11-03T16:00:00.000Z"))).toEqual({
    from: "2026-10-28T16:00:00.000Z",
    to: "2026-11-04T16:00:00.000Z",
    firstDate: "2026-10-29",
    lastDate: "2026-11-04",
  });
});
test("self is forced at SQL boundary and response strips member email and unexpected private fields", async () => {
  query.mockResolvedValue({ rows: [{ payload: payload(7, true) }] });
  const data = await loadUsageDashboard(
    7,
    { actorId: "owner-a", admin: false },
    now,
  );
  expect(query.mock.calls[0][1]).toEqual([
    "2026-10-27T16:00:00.000Z",
    "2026-11-03T16:00:00.000Z",
    "owner-a",
    "2026-10-28",
    "2026-11-03",
    false,
    JSON.stringify(USAGE_PRICEBOOK),
    USAGE_PRICE_VERSION,
  ]);
  expect(data.scope).toBe("self");
  expect(data.selectedUserId).toBe("owner-a");
  expect(data.members).toEqual([{ id: "owner-a", name: "甲" }]);
  expect(JSON.stringify(data)).not.toMatch(/never-return|email|secret/);
});
test("self cannot select a different opaque account, even when payload would be present", async () => {
  await expect(
    loadUsageDashboard(
      7,
      { actorId: "owner-a", admin: false, userId: "owner-b" },
      now,
    ),
  ).rejects.toMatchObject({ status: 403, code: "USAGE_SELF_ONLY" });
  expect(query).not.toHaveBeenCalled();
});
test("response scope guard rejects an unexpected foreign member rather than exposing it", async () => {
  await expect(
    loadUsageDashboard(7, { actorId: "owner-a", admin: false }, now),
  ).rejects.toMatchObject({ code: "USAGE_SCOPE_INVALID" });
});
test("administrator can aggregate every member or bind an opaque text identifier", async () => {
  let data = await loadUsageDashboard(
    7,
    { actorId: "admin", admin: true },
    now,
  );
  expect(query.mock.calls[0][1][2]).toBeNull();
  expect(data.members).toHaveLength(2);
  expect(data.summary.totalTokens).toBe(300);
  expect(data.summary.cost?.estimatedUSD).toBe(0.05);
  query.mockClear();
  data = await loadUsageDashboard(
    7,
    { actorId: "admin", admin: true, userId: "text-id_not-a-uuid" },
    now,
  );
  expect(query.mock.calls[0][1][2]).toBe("text-id_not-a-uuid");
  expect(data.selectedUserId).toBe("text-id_not-a-uuid");
});
test.each([0, 1, 8, 31, 365])(
  "rejects unsupported day span %s before database",
  async (days) => {
    await expect(
      loadUsageDashboard(days as 7, { actorId: "owner-a", admin: true }, now),
    ).rejects.toMatchObject({ status: 400 });
    expect(query).not.toHaveBeenCalled();
  },
);
test.each(["", "x".repeat(129), "bad\0id"])(
  "rejects invalid member identifiers safely",
  async (userId) => {
    await expect(
      loadUsageDashboard(7, { actorId: "admin", admin: true, userId }, now),
    ).rejects.toMatchObject({ status: 400 });
    expect(query).not.toHaveBeenCalled();
  },
);
test("unknown member yields404 without returning other member aggregates", async () => {
  query.mockResolvedValue({
    rows: [{ payload: { ...payload(), userExists: false } }],
  });
  await expect(
    loadUsageDashboard(
      7,
      { actorId: "admin", admin: true, userId: "missing" },
      now,
    ),
  ).rejects.toMatchObject({ status: 404 });
});
test("unknown tokens and unpriced money remain null, including nonzero operation counts", async () => {
  const raw = payload();
  const unknown = {
    ...zero(),
    requests: 1,
    unknownRequests: 1,
    cost: {
      estimatedUSD: null,
      pricedRequests: 0,
      unpricedRequests: 1,
      priceVersion: USAGE_PRICE_VERSION,
    },
  };
  raw.summary = unknown;
  raw.daily = raw.daily.map((d, i) => ({ ...d, ...(i ? zero() : unknown) }));
  raw.models = [{ ...raw.models[0], ...unknown }];
  raw.people = [{ ...raw.people[0], ...unknown }];
  query.mockResolvedValue({ rows: [{ payload: raw }] });
  const data = await loadUsageDashboard(
    7,
    { actorId: "admin", admin: true },
    now,
  );
  expect(data.summary.totalTokens).toBe(0);
  expect(data.summary.cost?.estimatedUSD).toBeNull();
  expect(data.summary.unknownRequests).toBe(1);
});
test.each([NaN, -1, Number.MAX_SAFE_INTEGER + 1])(
  "rejects unsafe token totals %s",
  async (inputTokens) => {
    const raw = payload();
    raw.summary.inputTokens = inputTokens;
    query.mockResolvedValue({ rows: [{ payload: raw }] });
    await expect(
      loadUsageDashboard(7, { actorId: "admin", admin: true }, now),
    ).rejects.toMatchObject({ code: "USAGE_TOTAL_INVALID" });
  },
);
test("rejects incomplete bucket aggregation instead of silently dropping usage", async () => {
  const raw = payload();
  raw.models = [];
  query.mockResolvedValue({ rows: [{ payload: raw }] });
  await expect(
    loadUsageDashboard(7, { actorId: "admin", admin: true }, now),
  ).rejects.toMatchObject({ code: "USAGE_TOTAL_INVALID" });
});
test("query excludes duplicated realtime generation ledger but retains superseded/retried billed operations", () => {
  expect(USAGE_DASHBOARD_SQL).toContain(
    "FROM family_generation WHERE kind='text'",
  );
  expect(USAGE_DASHBOARD_SQL).toContain("FROM family_realtime_usage");
  expect(USAGE_DASHBOARD_SQL).toContain("FROM family_voice_usage");
  expect(USAGE_DASHBOARD_SQL).not.toContain("superseded_at IS NULL");
  expect(USAGE_DASHBOARD_SQL).not.toContain("FROM family_realtime_turn");
  expect(USAGE_DASHBOARD_SQL).toContain("rank<=11");
  expect(USAGE_DASHBOARD_SQL).toContain("rank<=199");
  expect(USAGE_DASHBOARD_SQL).toContain("WHERE ($6::boolean OR id=$3)");
});
test("pricing uses the matching modality and source rate, date snapshots normalize, timed transcription waits completion", () => {
  expect(USAGE_DASHBOARD_SQL).toContain("p.category=n.category");
  expect(USAGE_DASHBOARD_SQL).toContain(
    "regexp_match(n.model,'^(.*)-([0-9]{4})-([0-9]{2})-([0-9]{2})$')",
  );
  expect(USAGE_DASHBOARD_SQL).toContain(
    "n.model_snapshot[3]::integer BETWEEN 1 AND 12",
  );
  expect(USAGE_DASHBOARD_SQL).toContain("n.model_snapshot[2]::integer%400=0");
  expect(USAGE_DASHBOARD_SQL).toContain("n.model_snapshot[2]::integer%100<>0");
  expect(USAGE_DASHBOARD_SQL).not.toMatch(/to_date|::date[^]*model_snapshot/);
  expect(USAGE_DASHBOARD_SQL).toContain("n.state='complete'");
  expect(USAGE_DASHBOARD_SQL).toContain(
    'n.audio_seconds::numeric*p."perMinute"/60',
  );
  expect(USAGE_DASHBOARD_SQL).toContain("n.usage_source='reported'");
});

test("all-time totals retain older usage while trend is limited to recent90days", async () => {
  const raw = payload(90);
  raw.daily = raw.daily.map((point) => ({ ...point, ...zero() }));
  query.mockResolvedValue({ rows: [{ payload: raw }] });
  const result = await loadUsageDashboard(
    "all",
    { actorId: "admin", admin: true },
    now,
  );
  expect(result.days).toBe("all");
  expect(result.trendDays).toBe(90);
  expect(result.summary.totalTokens).toBe(300);
  expect(result.summary.cost?.estimatedUSD).toBe(0.05);
  expect(result.daily).toHaveLength(90);
  expect(result.daily.every((day) => day.totalTokens === 0)).toBe(true);
  expect(query.mock.calls[0][1][0]).toBe("1970-01-01T00:00:00.000Z");
});
