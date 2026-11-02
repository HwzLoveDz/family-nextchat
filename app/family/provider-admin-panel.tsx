"use client";

import { useEffect, useRef, useState } from "react";
import type {
  ProviderAdminItem,
  ProviderAdminSnapshot,
  ProviderPolicyInput,
} from "./provider-admin-types";
import styles from "./provider-admin-panel.module.scss";

export interface ProviderAdminPanelProps {
  locked: boolean;
  scopeKey: string;
  isCurrent: () => boolean;
  onLoad: () => Promise<ProviderAdminSnapshot>;
  onRefresh: () => Promise<ProviderAdminSnapshot>;
  onSave: (input: ProviderPolicyInput) => Promise<ProviderAdminSnapshot>;
}
type DraftItem = { id: string; enabled: boolean };
const toDraft = (snapshot: ProviderAdminSnapshot): DraftItem[] =>
  snapshot.providers.map(({ id, enabled }) => ({ id, enabled }));
const signature = (items: DraftItem[]) =>
  JSON.stringify(items.map(({ id, enabled }) => [id, enabled]));
const keySet = (snapshot: ProviderAdminSnapshot) =>
  snapshot.providers
    .map(({ id }) => id)
    .sort()
    .join(",");
const updated = (value: string | null) => {
  if (!value) return "尚未查询";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("zh-CN", { hour12: false })
    : "时间未知";
};
const money = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
function balanceText(provider: ProviderAdminItem) {
  const balance = provider.balance;
  if (
    balance.state === "available" &&
    typeof balance.remainingUSD === "number" &&
    Number.isFinite(balance.remainingUSD)
  )
    return money.format(balance.remainingUSD);
  return {
    available: "暂时无法查询",
    permission_denied: "未授权查询",
    unsupported: "上游未提供余额",
    unavailable: "暂时无法查询",
    unchecked: "尚未查询",
  }[balance.state];
}
function failureText(error: unknown) {
  return error instanceof Error ? error.message : "操作没有完成，请稍后重试。";
}
function conflictError(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    ((error as { status?: unknown }).status === 409 ||
      (error as { code?: unknown }).code === "PROVIDER_POLICY_CONFLICT")
  );
}

/** A new scope mounts a fresh state container before any old async result lands. */
export function ProviderAdminPanel(props: ProviderAdminPanelProps) {
  return <ProviderAdminPanelSession key={props.scopeKey} {...props} />;
}

function ProviderAdminPanelSession(props: ProviderAdminPanelProps) {
  const latest = useRef(props);
  latest.current = props;
  const alive = useRef(true);
  const pending = useRef(false);
  const ticket = useRef(0);
  const [snapshot, setSnapshot] = useState<ProviderAdminSnapshot | null>(null);
  const [draft, setDraft] = useState<DraftItem[]>([]);
  const [telemetry, setTelemetry] = useState<Record<string, ProviderAdminItem>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const current = useRef({ snapshot, draft, conflict });
  current.current = { snapshot, draft, conflict };
  const dirty = !!snapshot && signature(draft) !== signature(toDraft(snapshot));
  const enabledCount = draft.filter((item) => item.enabled).length;
  const blocked = props.locked || busy;
  const canAct = () =>
    alive.current && !latest.current.locked && latest.current.isCurrent();

  const accept = (value: ProviderAdminSnapshot, replace: boolean) => {
    setTelemetry(
      Object.fromEntries(value.providers.map((item) => [item.id, item])),
    );
    const previous = current.current;
    const edited =
      previous.snapshot &&
      signature(previous.draft) !== signature(toDraft(previous.snapshot));
    if (!replace && previous.snapshot && edited) {
      if (
        value.revision !== previous.snapshot.revision ||
        keySet(value) !== keySet(previous.snapshot)
      )
        setConflict(true);
      return;
    }
    setSnapshot(value);
    setDraft(toDraft(value));
    setConflict(false);
  };
  const load = async (refresh: boolean, replace = false) => {
    if (!canAct() || pending.current || document.visibilityState !== "visible")
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    const seq = ++ticket.current;
    try {
      const value = await (refresh
        ? latest.current.onRefresh()
        : latest.current.onLoad());
      if (!canAct() || seq !== ticket.current) return;
      accept(value, replace);
      if (refresh) setNotice("余额查询状态已刷新。");
    } catch (failure) {
      if (canAct() && seq === ticket.current) setError(failureText(failure));
    } finally {
      if (alive.current && seq === ticket.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const save = async () => {
    const state = current.current;
    if (
      !canAct() ||
      pending.current ||
      !state.snapshot ||
      state.conflict ||
      !state.draft.some((item) => item.enabled)
    )
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const seq = ++ticket.current;
    const input: ProviderPolicyInput = {
      expectedRevision: state.snapshot.revision,
      order: state.draft.map(({ id }) => id),
      disabled: state.draft
        .filter(({ enabled }) => !enabled)
        .map(({ id }) => id),
    };
    try {
      const value = await latest.current.onSave(input);
      if (!canAct() || seq !== ticket.current) return;
      accept(value, true);
      setNotice("使用顺序已保存，将从下一次新请求生效。");
    } catch (failure) {
      if (!canAct() || seq !== ticket.current) return;
      if (conflictError(failure)) setConflict(true);
      setError(failureText(failure));
    } finally {
      if (alive.current && seq === ticket.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ticket.current++;
      pending.current = false;
    };
  }, []);
  useEffect(() => {
    if (props.locked) return;
    const synchronize = () => {
      if (document.visibilityState === "visible") void load(false);
    };
    synchronize();
    const timer = window.setInterval(synchronize, 30_000);
    document.addEventListener("visibilitychange", synchronize);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", synchronize);
    };
    // Callbacks are read through latest so parent renders cannot restart polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.locked]);

  const move = (index: number, delta: number) => {
    if (
      !canAct() ||
      pending.current ||
      index + delta < 0 ||
      index + delta >= draft.length
    )
      return;
    setDraft((previous) => {
      const result = [...previous];
      [result[index], result[index + delta]] = [
        result[index + delta],
        result[index],
      ];
      return result;
    });
    setNotice("");
  };
  return (
    <section
      className={styles.panel}
      aria-label="API 额度与使用顺序"
      aria-busy={busy}
    >
      <div className={styles.heading}>
        <div>
          <h2>API 额度与使用顺序</h2>
          <p>优先使用排在前面的已启用 Key。</p>
        </div>
        <button
          type="button"
          className={styles.quiet}
          disabled={blocked}
          onClick={() => void load(true)}
        >
          刷新余额
        </button>
      </div>
      {!snapshot ? (
        <p className={styles.help} role="status">
          {busy ? "正在读取 API 配置…" : "暂未读取到 API 配置。"}
        </p>
      ) : (
        <>
          <ol className={styles.list}>
            {draft.map((entry, index) => {
              const original = snapshot.providers.find(
                ({ id }) => id === entry.id,
              );
              if (!original) return null;
              const provider = telemetry[entry.id] ?? original;
              return (
                <li
                  key={entry.id}
                  className={`${styles.row} ${
                    !entry.enabled ? styles.disabled : ""
                  }`}
                >
                  <div className={styles.identity}>
                    <span
                      className={styles.position}
                      aria-label={`优先级 ${index + 1}`}
                    >
                      {index + 1}
                    </span>
                    <strong>{provider.name}</strong>
                    {provider.tier === "fallback" ? (
                      <span className={styles.badge}>备用</span>
                    ) : null}
                    <label className={styles.toggle}>
                      <input
                        type="checkbox"
                        aria-label={`启用 ${provider.name}`}
                        checked={entry.enabled}
                        disabled={blocked}
                        onChange={(event) => {
                          if (!canAct() || pending.current) return;
                          const enabled = event.target.checked;
                          setDraft((previous) =>
                            previous.map((item) =>
                              item.id === entry.id
                                ? { ...item, enabled }
                                : item,
                            ),
                          );
                          setNotice("");
                        }}
                      />
                      <span>{entry.enabled ? "已启用" : "已停用"}</span>
                    </label>
                  </div>
                  <div className={styles.metrics}>
                    <div>
                      <small>账户剩余额度 · USD</small>
                      <strong className={styles.balance}>
                        {balanceText(provider)}
                      </strong>
                      <small>
                        查询时间：{updated(provider.balance.checkedAt)}
                      </small>
                    </div>
                    <div>
                      <small>最近请求状态</small>
                      <span>
                        {provider.activity.state === "accepted"
                          ? "最近请求已接受"
                          : provider.activity.state === "quota_limited"
                          ? "额度或用量受限"
                          : "尚无请求记录"}
                      </span>
                      <small>
                        {provider.activity.checkedAt
                          ? updated(provider.activity.checkedAt)
                          : "请求状态不代表实时余额"}
                      </small>
                    </div>
                  </div>
                  <div className={styles.reorder}>
                    <button
                      type="button"
                      className={styles.quiet}
                      aria-label={`上移 ${provider.name}`}
                      disabled={blocked || index === 0}
                      onClick={() => move(index, -1)}
                    >
                      ↑ 上移
                    </button>
                    <button
                      type="button"
                      className={styles.quiet}
                      aria-label={`下移 ${provider.name}`}
                      disabled={blocked || index === draft.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      ↓ 下移
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
          {!draft.length ? (
            <p className={styles.help}>服务器尚未配置可用 Key。</p>
          ) : null}
          {conflict ? (
            <p className={styles.warning} role="status">
              后台配置已变化，当前修改已保留。请重新载入最新配置后再调整。
            </p>
          ) : null}
          {!enabledCount && draft.length ? (
            <p className={styles.warning} role="status">
              至少启用一把 Key，才能保存。
            </p>
          ) : null}
          <div className={styles.actions}>
            <button
              type="button"
              disabled={blocked || !dirty || conflict || !enabledCount}
              onClick={() => void save()}
            >
              保存使用顺序
            </button>
            <button
              type="button"
              className={styles.quiet}
              disabled={blocked || (!dirty && !conflict)}
              onClick={() => {
                if (!canAct() || pending.current) return;
                if (conflict) void load(false, true);
                else {
                  setDraft(toDraft(snapshot));
                  setError("");
                  setNotice("");
                }
              }}
            >
              {conflict ? "重新载入并放弃修改" : "撤销修改"}
            </button>
            <span className={styles.help}>
              {dirty ? "有尚未保存的修改" : "配置已同步"}
            </span>
          </div>
        </>
      )}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className={styles.help} role="status">
          {notice}
        </p>
      ) : null}
      <p className={styles.help}>
        页面打开时每 30 秒同步后台状态。余额以查询时间为准；同一 OpenAI 组织的
        Key 可能共用余额，不应相加。
      </p>
      <p className={styles.help}>
        当前普通项目 Key 查询账单可能返回
        403。显示“未授权查询”时，请到对应账户的官方账单核对余额；仅在上游授权并返回余额后显示真实金额。
        <a
          href="https://platform.openai.com/settings/organization/billing/overview"
          target="_blank"
          rel="noopener noreferrer"
        >
          打开 OpenAI 官方账单
        </a>
      </p>
      <p className={styles.help}>
        保存后，新文字和语音请求按此顺序使用；只有上游明确报告额度或用量限制时才尝试下一把。新增
        Key 默认排在已有 Key 之前。
      </p>
    </section>
  );
}
