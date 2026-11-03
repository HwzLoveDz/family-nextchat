"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FAMILY_THEMES } from "./themes";
import { WorkspaceSelect } from "./workspace-select";
import type {
  FamilySettingsProps,
  FamilySessionSummary,
} from "./workspace-types";
import type { RealtimeVad, RealtimeVoice } from "./realtime-types";
import styles from "./family-settings.module.scss";

const tabs = [
  ["general", "通用"],
  ["appearance", "外观"],
  ["voice", "语音"],
  ["account", "账户"],
  ["shortcuts", "快捷键"],
] as const;
const FONT_OPTIONS = [
  { value: "small", label: "小" },
  { value: "standard", label: "标准" },
  { value: "large", label: "大" },
] as const;
const DENSITY_OPTIONS = [
  { value: "comfortable", label: "舒适" },
  { value: "compact", label: "紧凑" },
] as const;
const SEND_OPTIONS = [
  { value: "enter", label: "Enter 发送" },
  { value: "mod-enter", label: "Ctrl / ⌘ + Enter 发送" },
] as const;
const VOICE_OPTIONS = [
  { value: "marin", label: "Marin" },
  { value: "cedar", label: "Cedar" },
  { value: "coral", label: "Coral" },
  { value: "sage", label: "Sage" },
] as const;
const VAD_OPTIONS = [
  { value: "natural", label: "自然停句" },
  { value: "fast", label: "快速回应" },
] as const;
const RECORD_OPTIONS = [
  { value: "hold", label: "按住说话，松开发送" },
  { value: "tap", label: "点击开始，再点结束" },
] as const;
type Tab = (typeof tabs)[number][0];
const date = (value: string) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleString("zh-CN")
    : "—";
};

function SettingsDialog(props: FamilySettingsProps) {
  const p = props;
  const live = useRef(props);
  live.current = props;
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const ticket = useRef(0);
  const [tab, setTab] = useState<Tab>("general");
  const [name, setName] = useState(p.user.name);
  const [account, setAccount] = useState<{
    owner: string;
    sessions: FamilySessionSummary[];
    busy: boolean;
    error: string;
    notice: string;
  }>({ owner: p.user.id, sessions: [], busy: false, error: "", notice: "" });

  const valid = (owner: string, seq: number) =>
    live.current.open &&
    live.current.user.id === owner &&
    ticket.current === seq;
  useEffect(() => {
    if (!p.open) return;
    ++ticket.current;
    setName(p.user.name);
    setAccount({
      owner: p.user.id,
      sessions: [],
      busy: false,
      error: "",
      notice: "",
    });
    setTab("general");
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    close.current?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        if (
          dialog.current?.querySelector(
            '[role="combobox"][aria-expanded="true"]',
          )
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        live.current.onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
        ) ?? [],
      );
      const first = controls[0],
        last = controls.at(-1);
      if (!first) {
        event.preventDefault();
        dialog.current?.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialog.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialog.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap, true);
    return () => {
      ++ticket.current;
      document.removeEventListener("keydown", trap, true);
      if (previous?.isConnected) previous.focus();
    };
    // Callbacks may change identity without opening a new dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open, p.user.id]);

  async function loadSessions() {
    const owner = live.current.user.id,
      seq = ++ticket.current;
    setAccount({ owner, sessions: [], busy: true, error: "", notice: "" });
    try {
      const result = await live.current.onLoadSessions();
      if (valid(owner, seq))
        setAccount({
          owner,
          sessions: result.sessions,
          busy: false,
          error: "",
          notice: "",
        });
    } catch {
      if (valid(owner, seq))
        setAccount({
          owner,
          sessions: [],
          busy: false,
          error: "加载登录设备失败，请重试。",
          notice: "",
        });
    }
  }
  useEffect(() => {
    if (p.open && tab === "account" && !p.locked) void loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open, p.user.id, tab, p.locked]);

  async function action(
    operation: () => Promise<unknown>,
    message: string,
    refresh = false,
  ) {
    if (live.current.locked) return;
    const owner = live.current.user.id,
      seq = ++ticket.current;
    setAccount((current) => ({
      ...current,
      owner,
      busy: true,
      error: "",
      notice: "",
    }));
    try {
      await operation();
      if (!valid(owner, seq)) return;
      if (refresh) {
        const result = await live.current.onLoadSessions();
        if (!valid(owner, seq)) return;
        setAccount({
          owner,
          sessions: result.sessions,
          busy: false,
          error: "",
          notice: message,
        });
      } else
        setAccount((current) => ({ ...current, busy: false, notice: message }));
    } catch {
      if (valid(owner, seq))
        setAccount((current) => ({
          ...current,
          busy: false,
          error: "操作未完成，请稍后重试。",
        }));
    }
  }

  if (!p.open || typeof document === "undefined") return null;
  const current =
    account.owner === p.user.id
      ? account
      : { sessions: [], busy: false, error: "", notice: "" };
  const disabled = p.locked || current.busy;
  const voiceLocked = p.locked || p.voiceBusy;
  return createPortal(
    <div
      className={styles.backdrop}
      style={{
        ...p.theme.variables,
        colorScheme: p.theme.dark ? "dark" : "light",
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) p.onClose();
      }}
    >
      <div
        ref={dialog}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
      >
        <header className={styles.header}>
          <h2 id={`${id}-title`}>设置</h2>
          <button
            ref={close}
            type="button"
            className={styles.close}
            aria-label="关闭设置"
            onClick={p.onClose}
          >
            ×
          </button>
        </header>
        <div className={styles.layout}>
          <nav
            className={styles.tabs}
            role="tablist"
            aria-label="设置分类"
            onKeyDown={(event) => {
              const keys = [
                "ArrowRight",
                "ArrowDown",
                "ArrowLeft",
                "ArrowUp",
                "Home",
                "End",
              ];
              if (!keys.includes(event.key)) return;
              event.preventDefault();
              let index = tabs.findIndex(([key]) => key === tab);
              index =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                  ? tabs.length - 1
                  : (index +
                      (["ArrowRight", "ArrowDown"].includes(event.key)
                        ? 1
                        : -1) +
                      tabs.length) %
                    tabs.length;
              setTab(tabs[index][0]);
              document.getElementById(`${id}-tab-${tabs[index][0]}`)?.focus();
            }}
          >
            {tabs.map(([key, label]) => (
              <button
                type="button"
                role="tab"
                id={`${id}-tab-${key}`}
                aria-controls={`${id}-panel`}
                aria-selected={tab === key}
                tabIndex={tab === key ? 0 : -1}
                key={key}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div
            className={styles.content}
            role="tabpanel"
            id={`${id}-panel`}
            aria-labelledby={`${id}-tab-${tab}`}
            tabIndex={0}
          >
            {tab === "general" ? (
              <>
                <h3>让聊天更顺手</h3>
                <p className={styles.help}>这些偏好保存在当前设备。</p>
                <div className={styles.row}>
                  <span>文字大小</span>
                  <div className={styles.rowControl}>
                    <WorkspaceSelect
                      label="文字大小"
                      variant="field"
                      value={p.preferences.font}
                      options={FONT_OPTIONS}
                      onChange={(value) =>
                        p.onPreferencesChange({
                          ...p.preferences,
                          font: value as typeof p.preferences.font,
                        })
                      }
                    />
                  </div>
                </div>
                <div className={styles.row}>
                  <span>内容间距</span>
                  <div className={styles.rowControl}>
                    <WorkspaceSelect
                      label="内容间距"
                      variant="field"
                      value={p.preferences.density}
                      options={DENSITY_OPTIONS}
                      onChange={(value) =>
                        p.onPreferencesChange({
                          ...p.preferences,
                          density: value as typeof p.preferences.density,
                        })
                      }
                    />
                  </div>
                </div>
                <div className={styles.row}>
                  <span>发送快捷键</span>
                  <div className={styles.rowControl}>
                    <WorkspaceSelect
                      label="发送快捷键"
                      variant="field"
                      value={p.preferences.sendKey}
                      options={SEND_OPTIONS}
                      onChange={(value) =>
                        p.onPreferencesChange({
                          ...p.preferences,
                          sendKey: value as typeof p.preferences.sendKey,
                        })
                      }
                    />
                  </div>
                </div>
                <p className={styles.help}>
                  Shift + Enter 始终换行。输入法选字时不会发送。
                </p>
              </>
            ) : null}
            {tab === "appearance" ? (
              <>
                <h3>主题配色</h3>
                <p className={styles.help}>立即预览，下次打开仍会保留。</p>
                <div
                  role="radiogroup"
                  aria-label="主题配色"
                  className={styles.themes}
                >
                  {FAMILY_THEMES.map((theme) => (
                    <label
                      key={theme.id}
                      className={`${styles.theme} ${
                        theme.id === p.theme.id ? styles.selected : ""
                      }`}
                    >
                      <input
                        type="radio"
                        name={`${id}-theme`}
                        value={theme.id}
                        aria-label={theme.label}
                        checked={theme.id === p.theme.id}
                        onChange={() => p.onThemeChange(theme.id)}
                      />
                      <span
                        className={styles.preview}
                        style={{
                          background: theme.variables["--paper"],
                          borderColor: theme.variables["--line"],
                        }}
                      >
                        <i
                          style={{
                            background: theme.variables["--sidebar-bg"],
                          }}
                        />
                        <b
                          style={{ background: theme.variables["--user-bg"] }}
                        />
                        <em
                          style={{ background: theme.variables["--accent"] }}
                        />
                      </span>
                      <strong>{theme.label}</strong>
                      <small>{theme.description}</small>
                    </label>
                  ))}
                </div>
              </>
            ) : null}
            {tab === "voice" ? (
              <>
                <h3>声音与对话</h3>
                <p className={styles.help}>
                  {p.voiceBusy
                    ? "通话或录音结束后可更改语音设置。"
                    : "连续语音中可以自然交谈，也可以开口打断。"}
                </p>
                <div className={styles.row}>
                  <span>连续语音声音</span>
                  <div className={styles.rowControl}>
                    <WorkspaceSelect
                      label="连续语音声音"
                      variant="field"
                      value={p.voice}
                      disabled={voiceLocked}
                      options={VOICE_OPTIONS}
                      onChange={(value) =>
                        p.onVoiceChange(value as RealtimeVoice)
                      }
                    />
                  </div>
                </div>
                <div className={styles.row}>
                  <span>停句方式</span>
                  <div className={styles.rowControl}>
                    <WorkspaceSelect
                      label="停句方式"
                      variant="field"
                      value={p.vad}
                      disabled={voiceLocked}
                      options={VAD_OPTIONS}
                      onChange={(value) => p.onVadChange(value as RealtimeVad)}
                    />
                  </div>
                </div>
                <div className={styles.row}>
                  <span>语音输入方式</span>
                  <div className={styles.rowControl}>
                    <WorkspaceSelect
                      label="语音输入方式"
                      variant="field"
                      value={p.tapRecord ? "tap" : "hold"}
                      disabled={voiceLocked}
                      options={RECORD_OPTIONS}
                      onChange={(value) => p.onTapRecordChange(value === "tap")}
                    />
                  </div>
                </div>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={p.autoReadVoice}
                    disabled={voiceLocked}
                    onChange={(e) => p.onAutoReadVoiceChange(e.target.checked)}
                  />
                  <span>语音输入后，自动朗读 AI 回复</span>
                </label>
                <p className={styles.help}>
                  连续语音需要麦克风权限；切到后台会结束通话。
                </p>
              </>
            ) : null}
            {tab === "account" ? (
              <>
                <h3>你的账户</h3>
                <p className={styles.help}>{p.user.email}</p>
                <form
                  className={styles.profile}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const next = name.trim();
                    if (next && next.length <= 80 && !disabled)
                      void action(() => p.onSaveProfile(next), "称呼已保存");
                  }}
                >
                  <label>
                    称呼
                    <input
                      aria-label="称呼"
                      value={name}
                      maxLength={80}
                      disabled={disabled}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={
                      disabled || !name.trim() || name.trim() === p.user.name
                    }
                  >
                    保存
                  </button>
                </form>
                <p className={styles.help}>
                  {p.user.role === "admin" ? "管理员" : "家庭成员"} · 登录有效至{" "}
                  {date(p.expiresAt)}
                </p>
                <div className={styles.sectionTitle}>
                  <h3>登录设备</h3>
                  <button
                    className={styles.quiet}
                    type="button"
                    disabled={disabled}
                    onClick={() => void loadSessions()}
                  >
                    刷新
                  </button>
                </div>
                <p className={styles.help}>
                  浏览器与系统信息仅用于辨认登录记录。
                </p>
                {current.busy ? (
                  <p role="status" className={styles.help}>
                    正在处理…
                  </p>
                ) : null}
                <ul className={styles.sessions}>
                  {current.sessions.map((session) => (
                    <li key={session.id}>
                      <div>
                        <strong>{session.label}</strong>
                        {session.current ? (
                          <span className={styles.badge}>当前设备</span>
                        ) : null}
                        <small>登录更新时间 {date(session.updatedAt)}</small>
                        <small>到期 {date(session.expiresAt)}</small>
                      </div>
                      {!session.current ? (
                        <button
                          type="button"
                          className={styles.quiet}
                          disabled={disabled}
                          aria-label={`退出 ${session.label}`}
                          onClick={() =>
                            void action(
                              () => p.onRevokeSession(session.id),
                              "已退出该设备",
                              true,
                            )
                          }
                        >
                          退出
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <div className={styles.accountActions}>
                  <button
                    type="button"
                    className={styles.quiet}
                    disabled={
                      disabled || !current.sessions.some((s) => !s.current)
                    }
                    onClick={() =>
                      void action(p.onRevokeOthers, "已退出其他设备", true)
                    }
                  >
                    退出其他设备
                  </button>
                  <button
                    type="button"
                    className={styles.danger}
                    disabled={disabled}
                    onClick={p.onLogout}
                  >
                    退出当前账户
                  </button>
                </div>
                {current.error ? (
                  <p role="alert" className={styles.error}>
                    {current.error}
                  </p>
                ) : null}
                {current.notice ? (
                  <p role="status" className={styles.help}>
                    {current.notice}
                  </p>
                ) : null}
              </>
            ) : null}
            {tab === "shortcuts" ? (
              <>
                <h3>键盘快捷键</h3>
                <dl className={styles.shortcuts}>
                  <div>
                    <dt>搜索会话</dt>
                    <dd>
                      <kbd>Ctrl / ⌘</kbd> <kbd>K</kbd>
                    </dd>
                  </div>
                  <div>
                    <dt>新建聊天</dt>
                    <dd>
                      <kbd>Ctrl / ⌘</kbd> <kbd>Shift</kbd> <kbd>O</kbd>
                    </dd>
                  </div>
                  <div>
                    <dt>打开设置</dt>
                    <dd>
                      <kbd>Ctrl / ⌘</kbd> <kbd>,</kbd>
                    </dd>
                  </div>
                  <div>
                    <dt>关闭弹窗</dt>
                    <dd>
                      <kbd>Esc</kbd>
                    </dd>
                  </div>
                  <div>
                    <dt>输入框换行</dt>
                    <dd>
                      <kbd>Shift</kbd> <kbd>Enter</kbd>
                    </dd>
                  </div>
                </dl>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
/** Closing the dialog also discards its account-specific state and requests. */
export function FamilySettings(props: FamilySettingsProps) {
  return props.open ? <SettingsDialog key={props.user.id} {...props} /> : null;
}
export default FamilySettings;
