"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { RealtimeController, RealtimePhase } from "./use-family-realtime";
import type { RealtimeVad, RealtimeVoice } from "./realtime-types";
import styles from "./realtime-panel.module.scss";

const labels: Record<RealtimePhase, string> = {
  idle: "准备开始",
  permission: "正在等待麦克风权限",
  connecting: "正在连接",
  listening: "正在听你说话",
  user_speaking: "你正在说话",
  thinking: "正在理解",
  speaking: "正在回答",
  reconnecting: "正在恢复连接",
  paused: "通话已暂停",
  ending: "正在挂断并保存",
  ended: "通话已结束",
  error: "通话已停止",
};
function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function RealtimePanel({
  controller: c,
  embedded = false,
}: {
  controller: RealtimeController;
  embedded?: boolean;
}) {
  const id = useId(),
    trigger = useRef<HTMLButtonElement>(null),
    hangup = useRef<HTMLButtonElement>(null),
    wasBusy = useRef(false),
    transcriptList = useRef<HTMLOListElement>(null),
    following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  useEffect(() => {
    if (c.busy && !wasBusy.current) {
      following.current = true;
      setShowLatest(false);
      hangup.current?.focus();
    } else if (!c.busy && wasBusy.current) trigger.current?.focus();
    wasBusy.current = c.busy;
  }, [c.busy]);
  useEffect(() => {
    if (!c.busy || !following.current || !transcriptList.current) return;
    transcriptList.current.scrollTop = transcriptList.current.scrollHeight;
  }, [c.busy, c.transcripts]);
  const final = c.transcripts.filter((item) => item.final).at(-1);
  if (embedded && !c.busy) return null;
  return (
    <section className={`${styles.root} ${c.busy ? styles.active : ""}`}>
      {!c.busy ? (
        <div className={styles.setup}>
          <details className={styles.settings}>
            <summary>声音与停句</summary>
            <div className={styles.options}>
              <label htmlFor={`${id}-voice`}>
                声音
                <select
                  id={`${id}-voice`}
                  value={c.voice}
                  onChange={(event) =>
                    c.setVoice(event.target.value as RealtimeVoice)
                  }
                >
                  <option value="marin">Marin</option>
                  <option value="cedar">Cedar</option>
                  <option value="coral">Coral</option>
                  <option value="sage">Sage</option>
                </select>
              </label>
              <label htmlFor={`${id}-vad`}>
                停句方式
                <select
                  id={`${id}-vad`}
                  value={c.vad}
                  onChange={(event) =>
                    c.setVad(event.target.value as RealtimeVad)
                  }
                >
                  <option value="natural">自然停句</option>
                  <option value="fast">快速回应</option>
                </select>
              </label>
            </div>
          </details>
          <button
            ref={trigger}
            type="button"
            disabled={!c.supported}
            onClick={() => void c.start()}
          >
            开始连续语音
          </button>
          <p className={styles.help}>语音模型：GPT Realtime 2.1 Mini</p>
          <p className={styles.help}>
            {c.supported
              ? "开始后可以自然说话，也可以随时打断回答。文字草稿和附件会保留。"
              : "此浏览器暂不支持连续语音，请使用按住说话或文字输入。"}
          </p>
        </div>
      ) : (
        <div
          role="dialog"
          aria-modal="false"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-help`}
          className={styles.panel}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              c.end();
            }
          }}
        >
          <div className={styles.top}>
            <div>
              <h2 id={`${id}-title`}>连续语音</h2>
              <p role="status" aria-live="polite">
                {labels[c.phase]}
                {c.muted ? " · 麦克风已静音" : ""}
              </p>
            </div>
            <time aria-label={`通话时长 ${clock(c.elapsed)}`}>
              {clock(c.elapsed)}
            </time>
          </div>
          <p className={styles.help} id={`${id}-help`}>
            说完后会自动回答。手机切到后台会结束通话；返回后可以重新开始。
          </p>
          <meter
            className={styles.meter}
            min={0}
            max={1}
            value={c.muted ? 0 : c.level}
            aria-label="麦克风音量"
          />
          {c.reconnectAttempt > 0 && c.phase === "reconnecting" ? (
            <p className={styles.help}>
              正在尝试恢复连接（{c.reconnectAttempt}
              /5），不会重复发送刚才的录音。
            </p>
          ) : null}
          {c.phase === "paused" ? (
            <div className={styles.notice}>
              <p>
                {c.audioBlocked
                  ? "手机音频被暂停，请点击继续。"
                  : "正在确认登录状态，麦克风发送和播放已暂停。"}
              </p>
              {c.audioBlocked ? (
                <button type="button" onClick={() => void c.resumeAudio()}>
                  继续音频
                </button>
              ) : null}
            </div>
          ) : null}
          {c.idleWarning !== null ? (
            <div className={styles.notice}>
              <p>有一会儿没有说话了，是否继续？</p>
              <button type="button" onClick={c.keepAlive}>
                继续通话
              </button>
            </div>
          ) : null}
          <ol
            ref={transcriptList}
            className={styles.transcripts}
            aria-label="实时语音字幕"
            aria-live="off"
            onScroll={(event) => {
              const list = event.currentTarget;
              following.current =
                list.scrollHeight - list.clientHeight - list.scrollTop < 72;
              setShowLatest(!following.current);
            }}
          >
            {!c.transcripts.length ? (
              <li className={styles.empty}>
                连接好后直接说话，字幕会出现在这里。
              </li>
            ) : (
              c.transcripts.map((item) => (
                <li
                  key={`${item.role}:${item.itemId}`}
                  className={
                    item.role === "user" ? styles.user : styles.assistant
                  }
                >
                  <strong>
                    {item.role === "user" ? "你" : "AI"}
                    {item.interrupted ? " · 已打断" : ""}
                  </strong>
                  <p>{item.text || "…"}</p>
                  {!item.final ? <small>识别中</small> : null}
                </li>
              ))
            )}
          </ol>
          {showLatest ? (
            <button
              type="button"
              className={styles.latest}
              onClick={() => {
                following.current = true;
                setShowLatest(false);
                if (transcriptList.current)
                  transcriptList.current.scrollTop =
                    transcriptList.current.scrollHeight;
              }}
            >
              回到最新字幕 ↓
            </button>
          ) : null}
          <span className={styles.srOnly} aria-live="polite">
            {final
              ? `${final.role === "user" ? "你" : "AI"}：${final.text}`
              : ""}
          </span>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              disabled={c.phase === "ending"}
              onClick={c.toggleMute}
              aria-pressed={c.muted}
            >
              {c.muted ? "取消静音" : "静音麦克风"}
            </button>
            <button
              type="button"
              className={styles.secondary}
              disabled={[
                "permission",
                "connecting",
                "ending",
                "reconnecting",
              ].includes(c.phase)}
              onClick={c.interrupt}
            >
              打断回答
            </button>
            <button
              ref={hangup}
              type="button"
              className={styles.hangup}
              disabled={c.phase === "ending"}
              onClick={c.end}
            >
              {c.phase === "ending" ? "正在保存…" : "挂断"}
            </button>
          </div>
        </div>
      )}
      {c.error ? (
        <p role="alert" className={styles.error}>
          {c.error}
        </p>
      ) : null}
    </section>
  );
}
