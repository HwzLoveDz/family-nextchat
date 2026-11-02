/** @jest-environment jsdom */
import { jest } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { UsageDashboard } from "../app/family/usage-dashboard";
import type {
  UsageDashboardCounters,
  UsageDashboardData,
  UsageDashboardDays,
} from "../app/family/usage-dashboard-types";

const zeros = (): UsageDashboardCounters => ({
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
    priceVersion: "2026-11-03",
  },
});
function data(
  days: UsageDashboardDays = "all",
  admin = false,
  userId?: string,
  token = 12345,
): UsageDashboardData {
  const counters: UsageDashboardCounters = {
    inputTokens: 2345,
    outputTokens: token - 2345,
    totalTokens: token,
    requests: 3,
    reportedRequests: 2,
    unknownRequests: 1,
    runningRequests: 0,
    cost: {
      estimatedUSD: 0.0375,
      pricedRequests: 2,
      unpricedRequests: 1,
      priceVersion: "2026-11-03",
    },
  };
  return {
    days,
    trendDays: days === "all" ? 90 : days,
    scope: admin ? "admin" : "self",
    timezone: "Asia/Shanghai",
    from: "2026-10-04T16:00:00Z",
    to: "2026-11-03T16:00:00Z",
    updatedAt: "2026-11-03T12:00:00Z",
    selectedUserId: admin ? userId ?? null : "member-a",
    members: admin
      ? [
          { id: "member-a", name: "家人甲" },
          { id: "member-b", name: "家人乙" },
        ]
      : [{ id: "member-a", name: "家人甲" }],
    membersTruncated: false,
    summary: counters,
    daily: Array.from({ length: days === "all" ? 90 : days }, (_, i) => ({
      date: `2026-10-${String(i + 1).padStart(2, "0")}`,
      ...(i ? zeros() : counters),
    })),
    models: [
      {
        id: "requested:gpt-4o-mini",
        model: "gpt-4o-mini",
        label: "gpt-4o-mini",
        source: "requested",
        ...counters,
      },
    ],
    people: [
      {
        id: userId ?? "member-a",
        name: userId === "member-b" ? "家人乙" : "家人甲",
        ...counters,
      },
    ],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const props = (admin = false) => ({
  admin,
  locked: false,
  scopeKey: "epoch1-owner-a",
  isCurrent: () => true,
  onLoad: jest.fn(async (days: UsageDashboardDays, userId?: string) =>
    data(days, admin, userId),
  ),
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("self page shows total tokens, dollars, trend/modelcharts without other member controls", async () => {
  const p = props();
  const { container } = render(<UsageDashboard {...p} />);
  expect((await screen.findAllByText("12,345")).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/0\.0375/)[0]).toBeInTheDocument();
  expect(screen.getByText("Token 总量")).toBeInTheDocument();
  expect(screen.getByText("总费用 · USD")).toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "用量成员" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "成员用量比较" }),
  ).not.toBeInTheDocument();
  expect(container.textContent).not.toContain("家人乙");
  expect(container.textContent).not.toMatch(
    /免责声明|与上游账单可能有差异|仅上游已报告|对应模态|含文字、图片和语音|上游报告模型|未报告实际模型|自然日统计|只展示当前账户/,
  );
  expect(
    screen.getByRole("img", { name: /模型Token占比/ }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("img", { name: /最近90天Token趋势/ }),
  ).toBeInTheDocument();
  expect(p.onLoad).toHaveBeenCalledWith("all", undefined);
});
test("administrator filters member and range, switches chart units, and sees comparison", async () => {
  const p = props(true);
  render(<UsageDashboard {...p} />);
  await screen.findAllByText("12,345");
  expect(
    screen.getByRole("region", { name: "成员用量比较" }),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "用量时间范围" }), {
    target: { value: "7" },
  });
  await waitFor(() => expect(p.onLoad).toHaveBeenLastCalledWith(7, undefined));
  fireEvent.change(screen.getByRole("combobox", { name: "用量成员" }), {
    target: { value: "member-b" },
  });
  await waitFor(() => expect(p.onLoad).toHaveBeenLastCalledWith(7, "member-b"));
  await screen.findByRole("img", { name: /最近7天/ });
  fireEvent.click(
    within(screen.getByRole("group", { name: "图表统计口径" })).getByRole(
      "button",
      { name: "费用" },
    ),
  );
  expect(
    screen.getByRole("img", { name: /模型费用（USD）占比/ }),
  ).toBeInTheDocument();
  fireEvent.click(
    within(screen.getByRole("group", { name: "图表统计口径" })).getByRole(
      "button",
      { name: "请求记录" },
    ),
  );
  expect(
    screen.getByRole("img", { name: /模型请求记录占比/ }),
  ).toBeInTheDocument();
});
test("unknown use is a separate count, unpriced dollars do not become zero", async () => {
  const value = data();
  value.summary = {
    ...zeros(),
    requests: 3,
    unknownRequests: 3,
    cost: {
      estimatedUSD: null,
      pricedRequests: 0,
      unpricedRequests: 3,
      priceVersion: "2026-11-03",
    },
  };
  value.models = [{ ...value.models[0], ...value.summary }];
  const p = { ...props(), onLoad: jest.fn(async () => value) };
  render(<UsageDashboard {...p} />);
  expect(
    await screen.findByText("0 条已计价 · 3 条未计价"),
  ).toBeInTheDocument();
  const costCard = screen.getByText("总费用 · USD").parentElement;
  expect(costCard?.querySelector("strong")).toHaveTextContent("—");
  expect(costCard?.querySelector("strong")).not.toHaveTextContent(/US\$0/);
  expect(screen.getByText("本期暂无 Token 记录。")).toBeInTheDocument();
});
test.each([
  [0.17401035, "$0.1740"],
  [0.000009, "<$0.0001"],
  [12.345678, "$12.3457"],
  [0, "$0.00"],
])("compact money %s preserves the API amount", async (amount, display) => {
  const value = data();
  value.summary.cost!.estimatedUSD = amount as number;
  const p = { ...props(), onLoad: jest.fn(async () => value) };
  render(<UsageDashboard {...p} />);
  await screen.findByText("总费用 · USD");
  const costCard = screen.getByText("总费用 · USD").parentElement;
  expect(costCard?.querySelector("strong")).toHaveTextContent(
    display as string,
  );
  expect(value.summary.cost!.estimatedUSD).toBe(amount);
});

test("a forged admin-scoped response is not shown on a self page", async () => {
  const p = { ...props(), onLoad: jest.fn(async () => data("all", true)) };
  const { container } = render(<UsageDashboard {...p} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("用量筛选已变化");
  expect(container.textContent).not.toContain("家人乙");
  expect(screen.queryAllByText("12,345")).toHaveLength(0);
});
test("old filter results are dropped and latest filter is loaded once in-flight read finishes", async () => {
  const pending = deferred<UsageDashboardData>();
  const p = props(true);
  p.onLoad.mockImplementationOnce(() => pending.promise);
  render(<UsageDashboard {...p} />);
  expect(p.onLoad).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole("combobox", { name: "用量时间范围" }), {
    target: { value: "7" },
  });
  expect(p.onLoad).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(data("all", true, undefined, 99999)));
  await waitFor(() => expect(p.onLoad).toHaveBeenLastCalledWith(7, undefined));
  expect((await screen.findAllByText("12,345")).length).toBeGreaterThan(0);
  expect(screen.queryAllByText("99,999")).toHaveLength(0);
});
test("scope change unmounts old private data and ignores late previous account response", async () => {
  const pending = deferred<UsageDashboardData>();
  const p = { ...props(), onLoad: jest.fn(() => pending.promise) };
  const { rerender, container } = render(<UsageDashboard {...p} />);
  const next = props();
  next.onLoad.mockResolvedValue(data("all", false, undefined, 7777));
  rerender(<UsageDashboard {...next} scopeKey="epoch2-owner-b" />);
  await screen.findAllByText("7,777");
  await act(async () => pending.resolve(data()));
  expect(screen.queryAllByText("12,345")).toHaveLength(0);
  expect(container.textContent).toContain("7,777");
});
test("live identity gate blocks actions before rerender and locked pages do not poll", async () => {
  let current = true;
  const p = { ...props(), isCurrent: () => current };
  const { rerender } = render(<UsageDashboard {...p} />);
  await screen.findAllByText("12,345");
  const calls = p.onLoad.mock.calls.length;
  current = false;
  fireEvent.click(screen.getByRole("button", { name: "刷新用量" }));
  fireEvent.change(screen.getByRole("combobox", { name: "用量时间范围" }), {
    target: { value: "7" },
  });
  expect(p.onLoad).toHaveBeenCalledTimes(calls);
  expect(screen.getByRole("combobox", { name: "用量时间范围" })).toHaveValue(
    "all",
  );
  rerender(<UsageDashboard {...p} locked />);
  expect(screen.getByRole("button", { name: "刷新用量" })).toBeDisabled();
});
test("visible-only polling is bounded, singleflight and removed on unmount", async () => {
  jest.useFakeTimers();
  let visibility = "visible";
  const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  const p = props();
  const { unmount } = render(<UsageDashboard {...p} />);
  await act(async () => {});
  expect(p.onLoad).toHaveBeenCalledTimes(1);
  visibility = "hidden";
  await act(async () => {
    jest.advanceTimersByTime(60000);
  });
  expect(p.onLoad).toHaveBeenCalledTimes(1);
  visibility = "visible";
  await act(async () => {
    fireEvent(document, new Event("visibilitychange"));
  });
  expect(p.onLoad).toHaveBeenCalledTimes(2);
  const pending = deferred<UsageDashboardData>();
  p.onLoad.mockImplementationOnce(() => pending.promise);
  await act(async () => {
    jest.advanceTimersByTime(30000);
  });
  await act(async () => {
    jest.advanceTimersByTime(60000);
  });
  expect(p.onLoad).toHaveBeenCalledTimes(3);
  unmount();
  await act(async () => pending.resolve(data()));
  await act(async () => {
    jest.advanceTimersByTime(60000);
  });
  expect(p.onLoad).toHaveBeenCalledTimes(3);
  if (original) Object.defineProperty(document, "visibilityState", original);
  else Reflect.deleteProperty(document, "visibilityState");
});
test("member labels render as plain text and model legend remains keyboard-accessible", async () => {
  const value = data("all", true);
  value.members[1].name = '<img src=x onerror="alert(1)">';
  const p = { ...props(true), onLoad: jest.fn(async () => value) };
  const { container } = render(<UsageDashboard {...p} />);
  await screen.findAllByText("12,345");
  expect(container.querySelector("img")).toBeNull();
  expect(
    screen.getByRole("option", { name: '<img src=x onerror="alert(1)">' }),
  ).toBeInTheDocument();
  const legend = screen.getByRole("button", { name: /gpt-4o-mini/ });
  fireEvent.click(legend);
  expect(legend).toHaveAttribute("aria-pressed", "true");
});
