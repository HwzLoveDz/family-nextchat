/** @jest-environment jsdom */
import { jest } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  ProviderAdminPanel,
  type ProviderAdminPanelProps,
} from "../app/family/provider-admin-panel";
import type { ProviderAdminSnapshot } from "../app/family/provider-admin-types";

const at = "2026-11-03T00:00:00Z";
function snapshot(revision = 0): ProviderAdminSnapshot {
  return {
    revision,
    updatedAt: at,
    providers: ["甲", "乙"].map((name, index) => ({
      id: `synthetic-id-${index}`,
      name,
      enabled: true,
      tier: "priority",
      order: index,
      balance: {
        state: "permission_denied",
        remainingUSD: null,
        checkedAt: at,
        scope: "organization",
      },
      activity: { state: "unobserved", checkedAt: null },
    })),
  };
}
function props(
  overrides: Partial<ProviderAdminPanelProps> = {},
): ProviderAdminPanelProps {
  return {
    locked: false,
    scopeKey: "owner-a",
    isCurrent: () => true,
    onLoad: jest.fn(async () => snapshot()),
    onRefresh: jest.fn(async () => snapshot()),
    onSave: jest.fn(async () => snapshot(1)),
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const rows = () => screen.getAllByRole("listitem");
const names = () =>
  rows().map((row) => row.querySelector("strong")?.textContent);
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("denied balance never becomes zero and genuine zero uses the reported currency", async () => {
  const value = snapshot();
  value.providers[1].balance = {
    state: "available",
    remainingUSD: 0,
    checkedAt: at,
    scope: "organization",
  };
  const p = props({ onLoad: jest.fn(async () => value) });
  const view = render(<ProviderAdminPanel {...p} />);
  expect(await screen.findByText("未授权查询")).toBeInTheDocument();
  expect(within(rows()[0]).queryByText(/0\.00/)).not.toBeInTheDocument();
  expect(within(rows()[1]).getByText(/0\.00/)).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "打开 OpenAI 官方账单" }),
  ).toHaveAttribute(
    "href",
    "https://platform.openai.com/settings/organization/billing/overview",
  );
  expect(view.container.textContent).not.toContain("synthetic-id");
  expect(
    screen.getByText(/同一 OpenAI 组织的 Key 可能共用余额/),
  ).toBeInTheDocument();
});

test("reorder and enable controls save explicit IDs and revision, without saving on edit", async () => {
  const result = snapshot(1);
  result.providers.reverse();
  result.providers[1].enabled = false;
  const save = jest.fn(async () => result);
  const p = props({ onSave: save });
  render(<ProviderAdminPanel {...p} />);
  await screen.findByRole("checkbox", { name: "启用 甲" });
  fireEvent.click(screen.getByRole("button", { name: "上移 乙" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "启用 甲" }));
  expect(names()).toEqual(["乙", "甲"]);
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "保存使用顺序" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      order: ["synthetic-id-1", "synthetic-id-0"],
      disabled: ["synthetic-id-0"],
      expectedRevision: 0,
    }),
  );
  expect(await screen.findByText(/使用顺序已保存/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "保存使用顺序" })).toBeDisabled();
});

test("all disabled edits are visible but cannot be saved; reset restores the last server policy", async () => {
  const p = props();
  render(<ProviderAdminPanel {...p} />);
  await screen.findByRole("checkbox", { name: "启用 甲" });
  fireEvent.click(screen.getByRole("checkbox", { name: "启用 甲" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "启用 乙" }));
  expect(screen.getByText(/至少启用一把 Key/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "保存使用顺序" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "撤销修改" }));
  expect(screen.getByRole("checkbox", { name: "启用 甲" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "启用 乙" })).toBeChecked();
  expect(p.onSave).not.toHaveBeenCalled();
});

test("poll refreshes telemetry while preserving an unsaved order and enable flags", async () => {
  jest.useFakeTimers();
  let value = snapshot();
  const load = jest.fn(async () => value);
  render(<ProviderAdminPanel {...props({ onLoad: load })} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "上移 乙" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "启用 甲" }));
  value = snapshot();
  value.providers[0].balance = {
    state: "available",
    remainingUSD: 12.3456,
    checkedAt: at,
    scope: "organization",
  };
  await act(async () => {
    jest.advanceTimersByTime(30_000);
  });
  expect(load).toHaveBeenCalledTimes(2);
  expect(names()).toEqual(["乙", "甲"]);
  expect(screen.getByRole("checkbox", { name: "启用 甲" })).not.toBeChecked();
  expect(screen.getByText(/12\.3456/)).toBeInTheDocument();
  expect(screen.queryByText(/后台配置已变化/)).not.toBeInTheDocument();
});

test("a changed revision or key set does not overwrite an editor and requires explicit reload", async () => {
  const next = snapshot(2);
  next.providers[0].name = "服务器新称呼";
  next.providers.push({
    ...next.providers[1],
    id: "synthetic-new",
    name: "新 Key",
  });
  const refresh = jest.fn(async () => next);
  const load = jest.fn(async () => snapshot());
  const p = props({ onLoad: load, onRefresh: refresh });
  render(<ProviderAdminPanel {...p} />);
  await screen.findByRole("checkbox", { name: "启用 甲" });
  fireEvent.click(screen.getByRole("button", { name: "上移 乙" }));
  fireEvent.click(screen.getByRole("button", { name: "刷新余额" }));
  expect(await screen.findByText(/后台配置已变化/)).toBeInTheDocument();
  expect(names()).toEqual(["乙", "服务器新称呼"]);
  expect(
    screen.queryByRole("checkbox", { name: "启用 新 Key" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "保存使用顺序" })).toBeDisabled();
  load.mockResolvedValue(next);
  fireEvent.click(screen.getByRole("button", { name: "重新载入并放弃修改" }));
  expect(
    await screen.findByRole("checkbox", { name: "启用 新 Key" }),
  ).toBeChecked();
  expect(screen.queryByText(/后台配置已变化/)).not.toBeInTheDocument();
});

test("a save conflict retains the exact draft and never retries the mutation", async () => {
  const save = jest.fn(async (): Promise<ProviderAdminSnapshot> => {
    throw Object.assign(new Error("配置已被另一位管理员更新"), { status: 409 });
  });
  render(<ProviderAdminPanel {...props({ onSave: save })} />);
  await screen.findByRole("checkbox", { name: "启用 甲" });
  fireEvent.click(screen.getByRole("button", { name: "上移 乙" }));
  fireEvent.click(screen.getByRole("button", { name: "保存使用顺序" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "另一位管理员更新",
  );
  expect(names()).toEqual(["乙", "甲"]);
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "保存使用顺序" })).toBeDisabled();
});

test("hidden or locked pages do not poll, pending calls never overlap, and unmount cleans timers", async () => {
  jest.useFakeTimers();
  const interval = jest.spyOn(window, "setInterval");
  const clear = jest.spyOn(window, "clearInterval");
  let visibility = "hidden";
  jest
    .spyOn(document, "visibilityState", "get")
    .mockImplementation(() => visibility as DocumentVisibilityState);
  const pending = deferred<ProviderAdminSnapshot>();
  const load = jest.fn(() => pending.promise);
  const p = props({ onLoad: load });
  const view = render(<ProviderAdminPanel {...p} />);
  await act(async () => {
    jest.advanceTimersByTime(60_000);
  });
  expect(load).not.toHaveBeenCalled();
  visibility = "visible";
  fireEvent(document, new Event("visibilitychange"));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => {
    jest.advanceTimersByTime(90_000);
  });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => {
    pending.resolve(snapshot());
  });
  view.rerender(<ProviderAdminPanel {...p} locked />);
  await act(async () => {
    jest.advanceTimersByTime(60_000);
  });
  expect(load).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(clear).toHaveBeenCalledWith(interval.mock.results[0].value);
  await act(async () => {
    jest.advanceTimersByTime(90_000);
  });
  expect(load).toHaveBeenCalledTimes(1);
});

test("late old-owner data cannot appear after a scope change", async () => {
  const old = deferred<ProviderAdminSnapshot>();
  const p = props({ onLoad: jest.fn(() => old.promise) });
  const view = render(<ProviderAdminPanel {...p} />);
  const next = snapshot(8);
  next.providers[0].name = "乙账户 Key";
  view.rerender(
    <ProviderAdminPanel
      {...props({ scopeKey: "owner-b", onLoad: jest.fn(async () => next) })}
    />,
  );
  expect(
    await screen.findByRole("checkbox", { name: "启用 乙账户 Key" }),
  ).toBeChecked();
  await act(async () => {
    old.resolve(snapshot());
  });
  expect(
    screen.queryByRole("checkbox", { name: "启用 甲" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("checkbox", { name: "启用 乙账户 Key" }),
  ).toBeChecked();
});

test("live current-scope guards block actions and late results before a rerender", async () => {
  let valid = true;
  const refreshed = deferred<ProviderAdminSnapshot>();
  const p = props({
    isCurrent: () => valid,
    onRefresh: jest.fn(() => refreshed.promise),
  });
  render(<ProviderAdminPanel {...p} />);
  await screen.findByRole("checkbox", { name: "启用 甲" });
  fireEvent.click(screen.getByRole("button", { name: "刷新余额" }));
  valid = false;
  const late = snapshot();
  late.providers[0].name = "不能显示的迟到 Key";
  await act(async () => {
    refreshed.resolve(late);
  });
  expect(
    screen.queryByRole("checkbox", { name: "启用 不能显示的迟到 Key" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "上移 乙" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "启用 甲" }));
  fireEvent.click(screen.getByRole("button", { name: "刷新余额" }));
  expect(names()).toEqual(["甲", "乙"]);
  expect(screen.getByRole("checkbox", { name: "启用 甲" })).toBeChecked();
  expect(p.onRefresh).toHaveBeenCalledTimes(1);
  expect(p.onSave).not.toHaveBeenCalled();
});
