"use client";

import { useEffect, useId, useRef, useState } from "react";
import type {
  UsageDashboardCounters,
  UsageDashboardData,
  UsageDashboardDays,
} from "./usage-dashboard-types";
import styles from "./usage-dashboard.module.scss";

export interface UsageDashboardProps {
  admin?: boolean;
  locked: boolean;
  scopeKey: string;
  isCurrent: () => boolean;
  onLoad: (
    days: UsageDashboardDays,
    userId?: string,
  ) => Promise<UsageDashboardData>;
}
type Metric = "tokens" | "requests" | "cost";
const colors = [
  "#7786e7",
  "#50ad8e",
  "#d9a349",
  "#d87e92",
  "#5a9fca",
  "#a88bc5",
  "#9aac54",
  "#d58b57",
  "#50a5a6",
  "#b09b6b",
  "#a87393",
  "#8b959f",
];
const number = (value: number) => new Intl.NumberFormat("zh-CN").format(value);
const usd = (value: number) =>
  value > 0 && value < 0.0001
    ? "<$0.0001"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: value > 0 && value < 1 ? 4 : 2,
        maximumFractionDigits: 4,
      }).format(value);
const measure = (item: UsageDashboardCounters, metric: Metric) =>
  metric === "tokens"
    ? item.totalTokens
    : metric === "requests"
    ? item.requests
    : item.cost?.estimatedUSD ?? 0;
const measureText = (value: number, metric: Metric) =>
  metric === "cost" ? usd(value) : number(value);
const metricLabel = (metric: Metric) =>
  metric === "tokens"
    ? "Token"
    : metric === "requests"
    ? "请求记录"
    : "费用（USD）";
const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });

export function UsageDashboard(props: UsageDashboardProps) {
  return (
    <UsageDashboardSession
      key={`${props.scopeKey}:${props.admin ? "admin" : "self"}`}
      {...props}
    />
  );
}
function UsageDashboardSession(props: UsageDashboardProps) {
  const live = useRef(props);
  live.current = props;
  const alive = useRef(true),
    sequence = useRef(0),
    busyRef = useRef(false);
  const [days, setDays] = useState<UsageDashboardDays>("all"),
    [member, setMember] = useState("");
  const [data, setData] = useState<UsageDashboardData | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [metric, setMetric] = useState<Metric>("tokens"),
    [selectedModel, setSelectedModel] = useState<string | null>(null);
  const requested = useRef({ days, member });
  requested.current = { days, member };
  const id = useId();
  const canRead = () =>
    alive.current && !live.current.locked && live.current.isCurrent();
  const load = async () => {
    if (!canRead() || busyRef.current || document.visibilityState !== "visible")
      return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    const request = { ...requested.current },
      ticket = ++sequence.current;
    try {
      const result = await live.current.onLoad(
        request.days,
        live.current.admin && request.member ? request.member : undefined,
      );
      if (
        !canRead() ||
        ticket !== sequence.current ||
        request.days !== requested.current.days ||
        request.member !== requested.current.member
      )
        return;
      // A mismatched response can never become a self dashboard or another filter's chart.
      if (
        result.days !== request.days ||
        (!live.current.admin && result.scope !== "self") ||
        (live.current.admin &&
          result.selectedUserId !== (request.member || null))
      )
        throw new Error("用量筛选已变化，请重新加载。");
      setData(result);
      setSelectedModel(null);
    } catch (failure) {
      if (
        canRead() &&
        ticket === sequence.current &&
        request.days === requested.current.days &&
        request.member === requested.current.member
      )
        setError(
          failure instanceof Error
            ? failure.message
            : "暂时无法读取用量，请稍后重试。",
        );
    } finally {
      busyRef.current = false;
      if (alive.current) {
        setBusy(false);
        if (
          ticket !== sequence.current ||
          request.days !== requested.current.days ||
          request.member !== requested.current.member
        )
          void load();
      }
    }
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    sequence.current++;
    if (props.locked) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    refresh();
    const timer = window.setInterval(refresh, 30000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
    // Current callbacks/filter refs avoid restarting polling on an unrelated parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, member, props.locked]);
  const matching =
    data &&
    data.days === days &&
    (!props.admin || data.selectedUserId === (member || null))
      ? data
      : null;
  const models = matching?.models ?? [],
    visiblePeople = matching?.people.filter((item) => item.requests > 0) ?? [];
  const total = matching ? measure(matching.summary, metric) : 0;
  const trendTotal =
    matching?.daily.reduce((sum, point) => sum + measure(point, metric), 0) ??
    0;
  const maxDay = Math.max(
    1,
    ...(matching?.daily.map((item) => measure(item, metric)) ?? []),
  );
  const maxPerson = Math.max(
    1,
    ...visiblePeople.map((item) => measure(item, metric)),
  );
  const admin = !!props.admin && matching?.scope === "admin";
  let offset = 0;
  const title = props.admin ? "成员用量分析" : "我的用量";
  const cost = matching?.summary.cost;
  return (
    <section className={styles.dashboard} aria-label={title} aria-busy={busy}>
      <div className={styles.heading}>
        <div>
          <h2>{title}</h2>
        </div>
        <button
          className={styles.quiet}
          disabled={props.locked || busy}
          onClick={() => void load()}
        >
          刷新用量
        </button>
      </div>
      <div className={styles.filters}>
        <label htmlFor={`${id}-days`}>
          时间范围
          <select
            id={`${id}-days`}
            aria-label="用量时间范围"
            value={days}
            disabled={props.locked}
            onChange={(e) => {
              if (!canRead()) return;
              setDays(
                (e.target.value === "all"
                  ? "all"
                  : Number(e.target.value)) as UsageDashboardDays,
              );
            }}
          >
            <option value="all">全部</option>
            <option value={7}>最近 7 天</option>
            <option value={30}>最近 30 天</option>
            <option value={90}>最近 90 天</option>
          </select>
        </label>
        {props.admin ? (
          <label htmlFor={`${id}-member`}>
            成员
            <select
              id={`${id}-member`}
              aria-label="用量成员"
              value={member}
              disabled={props.locked}
              onChange={(e) => {
                if (!canRead()) return;
                setMember(e.target.value);
              }}
            >
              <option value="">全部成员</option>
              {data?.members.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {!matching ? (
        <p role="status" className={styles.help}>
          {busy ? "正在读取用量…" : "暂未读取到用量。"}
        </p>
      ) : (
        <>
          <div className={styles.stats}>
            <div>
              <span>Token 总量</span>
              <strong>{number(matching.summary.totalTokens)}</strong>
            </div>
            <div>
              <span>总费用 · USD</span>
              <strong className={styles.money}>
                {cost?.estimatedUSD !== undefined && cost.estimatedUSD !== null
                  ? usd(cost.estimatedUSD)
                  : "—"}
              </strong>
              <small>
                {cost
                  ? `${number(cost.pricedRequests)} 条已计价 · ${number(
                      cost.unpricedRequests,
                    )} 条未计价`
                  : "—"}
              </small>
            </div>
            <div>
              <span>输入 Token</span>
              <strong>{number(matching.summary.inputTokens)}</strong>
            </div>
            <div>
              <span>输出 Token</span>
              <strong>{number(matching.summary.outputTokens)}</strong>
            </div>
            <div>
              <span>请求记录</span>
              <strong>{number(matching.summary.requests)}</strong>
            </div>
            <div>
              <span>未知用量记录</span>
              <strong>{number(matching.summary.unknownRequests)}</strong>
              <small>
                {number(matching.summary.runningRequests)} 条仍在处理中
              </small>
            </div>
          </div>
          <div
            className={styles.metricSwitch}
            role="group"
            aria-label="图表统计口径"
          >
            {(["tokens", "requests", "cost"] as const).map((value) => (
              <button
                key={value}
                className={styles.quiet}
                aria-pressed={metric === value}
                disabled={props.locked || (value === "cost" && !cost)}
                onClick={() => {
                  if (canRead()) setMetric(value);
                }}
              >
                {value === "tokens"
                  ? "Token"
                  : value === "requests"
                  ? "请求记录"
                  : "费用"}
              </button>
            ))}
          </div>
          <div className={styles.charts}>
            <section className={styles.card} aria-label="每日用量趋势">
              <div className={styles.cardHeading}>
                <h3>{days === "all" ? "每日趋势 · 最近 90 天" : "每日趋势"}</h3>
                <small>{metricLabel(metric)}</small>
              </div>
              <svg
                className={styles.trend}
                viewBox="0 0 660 220"
                role="img"
                aria-label={`最近${matching.trendDays}天${metricLabel(
                  metric,
                )}趋势`}
              >
                <title>{`最近${matching.trendDays}天${metricLabel(
                  metric,
                )}，共${measureText(trendTotal, metric)}`}</title>
                {[0, 1, 2, 3].map((i) => (
                  <line
                    key={i}
                    x1={36}
                    x2={650}
                    y1={20 + i * 52}
                    y2={20 + i * 52}
                    className={styles.gridLine}
                  />
                ))}
                {matching.daily.map((point, index) => {
                  const width = 600 / matching.daily.length,
                    height = (measure(point, metric) / maxDay) * 156;
                  const x = 40 + index * width;
                  return (
                    <g key={point.date}>
                      <title>{`${point.date}：${measureText(
                        measure(point, metric),
                        metric,
                      )}；输入${number(point.inputTokens)}，输出${number(
                        point.outputTokens,
                      )}，未知${number(point.unknownRequests)}条`}</title>
                      <rect
                        x={x}
                        y={176 - height}
                        width={Math.max(1, width - 2)}
                        height={Math.max(0, height)}
                        rx={Math.min(3, width / 4)}
                        fill={colors[0]}
                      />
                      {metric === "tokens" && point.totalTokens > 0 ? (
                        <rect
                          x={x}
                          y={176 - height}
                          width={Math.max(1, width - 2)}
                          height={
                            (height * point.outputTokens) / point.totalTokens
                          }
                          rx={Math.min(3, width / 4)}
                          fill={colors[1]}
                        />
                      ) : null}
                      {index === 0 ||
                      index === matching.daily.length - 1 ||
                      index === Math.floor(matching.daily.length / 2) ? (
                        <text x={x} y={201} className={styles.axis}>
                          {point.date.slice(5)}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
              {metric === "tokens" ? (
                <p className={styles.key}>
                  <i style={{ background: colors[0] }} />
                  输入
                  <i style={{ background: colors[1] }} />
                  输出
                </p>
              ) : null}
              <details className={styles.details}>
                <summary>查看每日明细</summary>
                <div className={styles.tableScroll}>
                  <table>
                    <thead>
                      <tr>
                        <th>日期</th>
                        <th>输入 Token</th>
                        <th>输出 Token</th>
                        <th>请求记录</th>
                        <th>未知用量</th>
                        {cost ? <th>费用 · USD</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {matching.daily.map((point) => (
                        <tr key={point.date}>
                          <th>{point.date}</th>
                          <td>{number(point.inputTokens)}</td>
                          <td>{number(point.outputTokens)}</td>
                          <td>{number(point.requests)}</td>
                          <td>{number(point.unknownRequests)}</td>
                          {cost ? (
                            <td>
                              {point.cost?.estimatedUSD == null
                                ? "—"
                                : usd(point.cost.estimatedUSD)}
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </section>
            <section className={styles.card} aria-label="模型用量分布">
              <div className={styles.cardHeading}>
                <h3>模型分布</h3>
                <small>{metricLabel(metric)}</small>
              </div>
              <div className={styles.donutWrap}>
                <svg
                  viewBox="0 0 230 230"
                  className={styles.donut}
                  role="img"
                  aria-label={`模型${metricLabel(metric)}占比`}
                >
                  <title>{`模型${metricLabel(metric)}分布`}</title>
                  <circle
                    cx={115}
                    cy={115}
                    r={82}
                    fill="none"
                    stroke="var(--line)"
                    strokeWidth={27}
                  />
                  {models.map((model, index) => {
                    const value = measure(model, metric),
                      fraction = total > 0 ? value / total : 0,
                      start = offset;
                    offset += fraction;
                    if (!fraction) return null;
                    return (
                      <circle
                        key={model.id}
                        cx={115}
                        cy={115}
                        r={82}
                        pathLength={100}
                        fill="none"
                        stroke={colors[index % colors.length]}
                        strokeWidth={27}
                        strokeDasharray={`${fraction * 100} ${
                          100 - fraction * 100
                        }`}
                        strokeDashoffset={-start * 100}
                        transform="rotate(-90 115 115)"
                        opacity={
                          selectedModel &&
                          selectedModel !== model.id?.toString()
                            ? 0.25
                            : 1
                        }
                      >
                        <title>{`${model.label}：${measureText(
                          value,
                          metric,
                        )}，${(fraction * 100).toFixed(1)}%`}</title>
                      </circle>
                    );
                  })}
                  <text
                    x={115}
                    y={111}
                    textAnchor="middle"
                    className={styles.donutTotal}
                  >
                    {measureText(total, metric)}
                  </text>
                  <text
                    x={115}
                    y={132}
                    textAnchor="middle"
                    className={styles.axis}
                  >
                    {metricLabel(metric)}
                  </text>
                </svg>
              </div>
              {!total ? (
                <p className={styles.help}>
                  {metric === "tokens"
                    ? "本期暂无 Token 记录。"
                    : metric === "cost"
                    ? "本期暂无费用记录。"
                    : "本期暂无请求记录。"}
                </p>
              ) : null}
              <ul className={styles.legend}>
                {models.map((model, index) => (
                  <li key={model.id}>
                    <button
                      className={styles.legendButton}
                      aria-pressed={selectedModel === model.id}
                      onClick={() =>
                        setSelectedModel((value) =>
                          value === model.id ? null : model.id,
                        )
                      }
                    >
                      <i
                        style={{ background: colors[index % colors.length] }}
                      />
                      <span>{model.label}</span>
                      <b>
                        {measureText(measure(model, metric), metric)}
                        <small>
                          {total > 0
                            ? `${(
                                (measure(model, metric) / total) *
                                100
                              ).toFixed(1)}%`
                            : "—"}
                        </small>
                      </b>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          {admin ? (
            <section
              className={`${styles.card} ${styles.people}`}
              aria-label="成员用量比较"
            >
              <div className={styles.cardHeading}>
                <h3>成员用量</h3>
                <small>{metricLabel(metric)}</small>
              </div>
              {!visiblePeople.length ? (
                <p className={styles.help}>本期暂无请求记录。</p>
              ) : (
                visiblePeople.map((person) => (
                  <div key={person.id ?? "other"} className={styles.person}>
                    <div>
                      <button
                        className={styles.personName}
                        disabled={!person.id || props.locked}
                        onClick={() => {
                          if (canRead() && person.id) setMember(person.id);
                        }}
                      >
                        {person.name}
                      </button>
                      <span>
                        {measureText(measure(person, metric), metric)}
                      </span>
                    </div>
                    <div className={styles.track}>
                      <i
                        style={{
                          width: `${
                            (measure(person, metric) / maxPerson) * 100
                          }%`,
                          background: colors[0],
                        }}
                      />
                    </div>
                    <small>
                      {number(person.requests)} 条请求记录 ·{" "}
                      {number(person.unknownRequests)} 条用量未知
                      {person.cost?.unpricedRequests
                        ? ` · ${number(person.cost.unpricedRequests)} 条未计价`
                        : ""}
                    </small>
                  </div>
                ))
              )}
            </section>
          ) : null}
          <p className={styles.help}>更新时间：{date(matching.updatedAt)}</p>
          {matching.membersTruncated && props.admin ? (
            <p className={styles.help}>
              成员选择列表仅展示前 200 位；汇总及“其他成员”仍包含全部记录。
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
