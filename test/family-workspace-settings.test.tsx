/** @jest-environment jsdom */
import { jest } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { FamilySettings } from "../app/family/family-settings";
import { getFamilyTheme } from "../app/family/themes";
import type { FamilySettingsProps } from "../app/family/workspace-types";
import type { FamilyMe } from "../app/family/types";

function props(
  overrides: Partial<FamilySettingsProps> = {},
): FamilySettingsProps {
  return {
    open: true,
    onClose: jest.fn(),
    user: {
      id: "owner-a",
      name: "合成成员",
      email: "a@test.invalid",
      role: "member",
      status: "approved",
    },
    expiresAt: "2026-12-01T00:00:00Z",
    theme: getFamilyTheme("paper"),
    onThemeChange: jest.fn(),
    preferences: { font: "standard", density: "comfortable", sendKey: "enter" },
    onPreferencesChange: jest.fn(),
    voice: "marin",
    onVoiceChange: jest.fn(),
    vad: "natural",
    onVadChange: jest.fn(),
    voiceBusy: false,
    autoReadVoice: true,
    onAutoReadVoiceChange: jest.fn(),
    tapRecord: false,
    onTapRecordChange: jest.fn(),
    locked: false,
    onSaveProfile: jest.fn(
      async (): Promise<FamilyMe> => ({
        user: {
          id: "owner-a",
          name: "更新称呼",
          email: "a@test.invalid",
          role: "member",
          status: "approved",
        },
        sessionExpiresAt: "2026-12-01",
      }),
    ),
    onLoadSessions: jest.fn(async () => ({
      sessions: [
        {
          id: "current-id",
          current: true,
          label: "Chrome · Windows",
          createdAt: "2026-11-01",
          updatedAt: "2026-11-02",
          expiresAt: "2026-12-01",
        },
        {
          id: "other-id",
          current: false,
          label: "Safari · iOS",
          createdAt: "2026-11-01",
          updatedAt: "2026-11-02",
          expiresAt: "2026-12-01",
        },
      ],
    })),
    onRevokeSession: jest.fn(async () => {}),
    onRevokeOthers: jest.fn(async () => {}),
    onLogout: jest.fn(),
    ...overrides,
  };
}
afterEach(cleanup);
test("dialog traps focus, supports tab arrows, Escape and restores launch focus", () => {
  const p = props();
  const launch = document.createElement("button");
  document.body.append(launch);
  launch.focus();
  const view = render(<FamilySettings {...p} />);
  expect(screen.getByRole("button", { name: "关闭设置" })).toHaveFocus();
  const last = screen.getByRole("combobox", { name: "发送快捷键" });
  last.focus();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(screen.getByRole("button", { name: "关闭设置" })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("tab", { name: "通用" }), {
    key: "ArrowRight",
  });
  expect(screen.getByRole("tab", { name: "外观" })).toHaveFocus();
  expect(screen.getAllByRole("radio")).toHaveLength(8);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(p.onClose).toHaveBeenCalledTimes(1);
  view.rerender(<FamilySettings {...p} open={false} />);
  expect(launch).toHaveFocus();
  launch.remove();
});
test("settings call enum callbacks and lock voice choices for an active call", () => {
  const p = props();
  const view = render(<FamilySettings {...p} />);
  fireEvent.change(screen.getByRole("combobox", { name: "文字大小" }), {
    target: { value: "large" },
  });
  expect(p.onPreferencesChange).toHaveBeenCalledWith({
    font: "large",
    density: "comfortable",
    sendKey: "enter",
  });
  fireEvent.click(screen.getByRole("tab", { name: "外观" }));
  fireEvent.click(screen.getByRole("radio", { name: "石墨" }));
  expect(p.onThemeChange).toHaveBeenCalledWith("graphite");
  fireEvent.click(screen.getByRole("tab", { name: "语音" }));
  fireEvent.change(screen.getByRole("combobox", { name: "连续语音声音" }), {
    target: { value: "cedar" },
  });
  expect(p.onVoiceChange).toHaveBeenCalledWith("cedar");
  view.rerender(<FamilySettings {...p} voiceBusy />);
  expect(screen.getByRole("combobox", { name: "连续语音声音" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "语音输入方式" })).toBeDisabled();
});
test("account actions expose only sanitized device summaries and never revoke the current device", async () => {
  const p = props();
  render(<FamilySettings {...p} />);
  fireEvent.click(screen.getByRole("tab", { name: "账户" }));
  await screen.findByText("Safari · iOS");
  expect(
    screen.queryByRole("button", { name: "退出 Chrome · Windows" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "退出 Safari · iOS" }));
  await waitFor(() =>
    expect(p.onRevokeSession).toHaveBeenCalledWith("other-id"),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled(),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "称呼" }), {
    target: { value: " 更新称呼 " },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(p.onSaveProfile).toHaveBeenCalledWith("更新称呼"));
  await screen.findByText("称呼已保存");
});
test("late session responses cannot populate a closed or different owner's dialog", async () => {
  let resolve!: (value: any) => void;
  const pending = new Promise<any>((done) => {
    resolve = done;
  });
  const p = props({ onLoadSessions: jest.fn(() => pending) });
  const view = render(<FamilySettings {...p} />);
  fireEvent.click(screen.getByRole("tab", { name: "账户" }));
  view.rerender(<FamilySettings {...p} open={false} />);
  await act(async () =>
    resolve({
      sessions: [
        {
          id: "old",
          current: false,
          label: "OLD OWNER DEVICE",
          createdAt: "2026-11-01",
          updatedAt: "2026-11-02",
          expiresAt: "2026-12-01",
        },
      ],
    }),
  );
  view.rerender(
    <FamilySettings
      {...p}
      user={{
        ...p.user,
        id: "owner-b",
        name: "第二成员",
        email: "b@test.invalid",
      }}
    />,
  );
  expect(screen.queryByText("OLD OWNER DEVICE")).toBeNull();
  expect(screen.queryByText("a@test.invalid")).toBeNull();
});
