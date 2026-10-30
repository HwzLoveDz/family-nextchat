"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FamilyAttachmentMeta } from "./types";
import {
  abortAttachment,
  attachmentSize,
  ATTACHMENT_LIMITS,
  prepareAttachment,
  safeAttachmentName,
  type PreparedAttachment,
} from "./attachment-browser";
import styles from "./attachment.module.scss";

export type AttachmentScope = { key: string; isCurrent: () => boolean };
export type DraftAttachment = PreparedAttachment & {
  localId: string;
  status: "preparing" | "ready" | "error";
  previewUrl?: string;
  error?: string;
};

export function useDraftAttachments(
  scope: AttachmentScope,
  onError: (message: string) => void,
) {
  const latest = useRef({ scope, onError });
  latest.current = { scope, onError };
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const current = useRef<DraftAttachment[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const generation = useRef(0);
  const mounted = useRef(true);
  const commit = useCallback((next: DraftAttachment[]) => {
    current.current = next;
    if (mounted.current) setItems(next);
  }, []);
  const clear = useCallback(() => {
    generation.current++;
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    current.current.forEach((item) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
    commit([]);
  }, [commit]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clear();
    };
  }, [clear]);
  const remove = useCallback(
    (id: string) => {
      controllers.current.get(id)?.abort();
      controllers.current.delete(id);
      const item = current.current.find((entry) => entry.localId === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      commit(current.current.filter((entry) => entry.localId !== id));
    },
    [commit],
  );
  const addFiles = useCallback(
    async (files: File[]) => {
      if (
        !files.length ||
        current.current.some((item) => item.status === "preparing")
      )
        return;
      if (files.length + current.current.length > ATTACHMENT_LIMITS.count) {
        latest.current.onError("一次最多 3 个附件，请减少选择数量。");
        return;
      }
      const key = latest.current.scope.key,
        version = generation.current;
      const isImage = (file: File) =>
        /^image\//i.test(file.type) ||
        /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
      const pending: DraftAttachment[] = files.map((file) => ({
        file,
        localId: crypto.randomUUID(),
        kind: isImage(file)
          ? "image"
          : /\.pdf$/i.test(file.name)
          ? "pdf"
          : "text",
        status: "preparing",
      }));
      commit([...current.current, ...pending]);
      for (const item of [...pending].sort(
        (a, b) => Number(a.kind === "image") - Number(b.kind === "image"),
      )) {
        if (
          version !== generation.current ||
          key !== latest.current.scope.key ||
          !latest.current.scope.isCurrent()
        )
          return;
        if (!current.current.some((entry) => entry.localId === item.localId))
          continue;
        const controller = new AbortController();
        controllers.current.set(item.localId, controller);
        try {
          const used = current.current
            .filter((entry) => entry.status === "ready")
            .reduce((total, entry) => total + entry.file.size, 0);
          const imageCount = current.current.filter(
            (entry) => entry.status === "preparing" && entry.kind === "image",
          ).length;
          const budget =
            item.kind === "image"
              ? Math.floor(
                  (ATTACHMENT_LIMITS.totalBytes - used) /
                    Math.max(1, imageCount),
                )
              : ATTACHMENT_LIMITS.totalBytes - used;
          const prepared = await prepareAttachment(
            item.file,
            budget,
            controller.signal,
          );
          abortAttachment(controller.signal);
          if (
            version !== generation.current ||
            key !== latest.current.scope.key ||
            !latest.current.scope.isCurrent() ||
            !current.current.some((entry) => entry.localId === item.localId)
          )
            continue;
          const previewUrl =
            prepared.kind === "image"
              ? URL.createObjectURL(prepared.file)
              : undefined;
          commit(
            current.current.map((entry) =>
              entry.localId === item.localId
                ? {
                    ...prepared,
                    localId: item.localId,
                    status: "ready",
                    previewUrl,
                  }
                : entry,
            ),
          );
        } catch (failure) {
          if (
            !controller.signal.aborted &&
            version === generation.current &&
            key === latest.current.scope.key &&
            latest.current.scope.isCurrent()
          )
            commit(
              current.current.map((entry) =>
                entry.localId === item.localId
                  ? {
                      ...entry,
                      status: "error",
                      error:
                        failure instanceof Error
                          ? failure.message
                          : "附件处理失败，请重新选择。",
                    }
                  : entry,
              ),
            );
        } finally {
          if (controllers.current.get(item.localId) === controller)
            controllers.current.delete(item.localId);
        }
      }
    },
    [commit],
  );
  return {
    items,
    preparing: items.some((item) => item.status === "preparing"),
    hasErrors: items.some((item) => item.status === "error"),
    clear,
    remove,
    addFiles,
    hasAny: () => current.current.length > 0,
    snapshot: () => {
      if (current.current.some((item) => item.status !== "ready"))
        throw new Error("请等待附件处理完成，或移除无法发送的附件。");
      return [...current.current];
    },
  };
}

export function AttachmentComposer({
  items,
  disabled,
  editing,
  error,
  onFiles,
  onRemove,
}: {
  items: DraftAttachment[];
  disabled: boolean;
  editing: boolean;
  error?: string;
  onFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <section className={styles.composer} aria-label="待发送附件">
      <input
        ref={input}
        className={styles.fileInput}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp,.pdf,.txt,.md,.csv,.json,.log"
        aria-label="选择附件文件"
        disabled={
          disabled ||
          editing ||
          items.some((item) => item.status === "preparing")
        }
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          onFiles(files);
        }}
      />
      <div className={styles.pickerRow}>
        <button
          type="button"
          className={styles.pickButton}
          disabled={
            disabled ||
            editing ||
            items.length >= 3 ||
            items.some((item) => item.status === "preparing")
          }
          onClick={() => input.current?.click()}
        >
          ＋ 选择附件
        </button>
        <small>
          {editing
            ? "原附件会一并保留"
            : "图片 / PDF / 文本 · 最多 3 个，合计 2 MB"}
        </small>
      </div>
      {!editing && items.length ? (
        <ul className={styles.draftList}>
          {items.map((item) => (
            <li key={item.localId} className={styles.draftItem}>
              {item.previewUrl ? (
                <img src={item.previewUrl} alt={item.file.name} />
              ) : (
                <span className={styles.fileBadge} aria-hidden="true">
                  {item.kind === "pdf"
                    ? "PDF"
                    : item.kind === "image"
                    ? "图"
                    : "文"}
                </span>
              )}
              <div>
                <strong>{item.file.name}</strong>
                <small>
                  {item.status === "preparing"
                    ? "正在处理…"
                    : attachmentSize(item.file.size)}
                </small>
                {item.error ? (
                  <p className={styles.error} role="alert">
                    {item.error}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                className={styles.removeButton}
                disabled={disabled}
                aria-label={`移除附件 ${item.file.name}`}
                onClick={() => onRemove(item.localId)}
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error && !editing ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function SavedAttachment({
  attachment,
  scope,
  admin,
  onUnauthorized,
}: {
  attachment: FamilyAttachmentMeta;
  scope: AttachmentScope;
  admin: boolean;
  onUnauthorized: () => void;
}) {
  const latest = useRef({ scope, onUnauthorized });
  latest.current = { scope, onUnauthorized };
  const host = useRef<HTMLLIElement>(null);
  const [visible, setVisible] = useState(
    typeof IntersectionObserver === "undefined",
  );
  const [preview, setPreview] = useState<{
    key: string;
    url: string;
    blob: Blob;
  } | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const controllers = useRef(new Set<AbortController>()),
    urls = useRef(new Set<string>()),
    timers = useRef(new Set<number>());
  const alive = useRef(true);
  const key = `${scope.key}:${admin ? "admin" : "owner"}:${attachment.id}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !host.current) return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "150px" },
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [key]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controllers.current.forEach((controller) => controller.abort());
      controllers.current.clear();
      urls.current.forEach((url) => URL.revokeObjectURL(url));
      urls.current.clear();
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
    };
  }, [key]);
  const load = async (controller: AbortController, captured: string) => {
    const timer = window.setTimeout(() => controller.abort(), 30000);
    timers.current.add(timer);
    controllers.current.add(controller);
    try {
      const response = await fetch(
        `/api/family/${admin ? "admin/" : ""}attachments/${encodeURIComponent(
          attachment.id,
        )}`,
        {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        },
      );
      if (
        controller.signal.aborted ||
        !alive.current ||
        captured !== currentKey.current ||
        !latest.current.scope.isCurrent()
      )
        throw new DOMException("Aborted", "AbortError");
      if (!response.ok) {
        if ([401, 403].includes(response.status))
          latest.current.onUnauthorized();
        throw new Error("附件暂不可用，请稍后重试。");
      }
      const blob = await response.blob();
      if (
        controller.signal.aborted ||
        !alive.current ||
        captured !== currentKey.current ||
        !latest.current.scope.isCurrent()
      )
        throw new DOMException("Aborted", "AbortError");
      if (blob.size > ATTACHMENT_LIMITS.fileBytes)
        throw new Error("附件数据超出限制。");
      return blob;
    } finally {
      controller.abort();
      controllers.current.delete(controller);
      window.clearTimeout(timer);
      timers.current.delete(timer);
    }
  };
  useEffect(() => {
    if (!visible || attachment.kind !== "image") return;
    const controller = new AbortController();
    const captured = key;
    let active = true;
    setError("");
    void load(controller, captured)
      .then((blob) => {
        if (
          !active ||
          captured !== currentKey.current ||
          !latest.current.scope.isCurrent()
        )
          return;
        if (
          !["image/jpeg", "image/png", "image/webp"].includes(
            blob.type.split(";")[0],
          )
        )
          throw new Error("图片格式无法预览。");
        const url = URL.createObjectURL(blob);
        urls.current.add(url);
        setPreview({ key: captured, url, blob });
      })
      .catch((failure) => {
        if (
          active &&
          captured === currentKey.current &&
          latest.current.scope.isCurrent()
        )
          setError(
            failure instanceof DOMException && failure.name === "AbortError"
              ? "附件加载超时，请重试。"
              : failure instanceof Error
              ? failure.message
              : "附件加载失败。",
          );
      });
    return () => {
      active = false;
      controller.abort();
      urls.current.forEach((url) => URL.revokeObjectURL(url));
      urls.current.clear();
    };
    // Keys represent ownership; keep callbacks in latest so stream updates do not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, visible, retry, attachment.kind]);
  const download = async () => {
    if (!alive.current || !latest.current.scope.isCurrent() || downloading)
      return;
    const captured = key,
      controller = new AbortController();
    setDownloading(true);
    setError("");
    try {
      const blob =
        preview?.key === captured
          ? preview.blob
          : await load(controller, captured);
      if (
        !alive.current ||
        captured !== currentKey.current ||
        !latest.current.scope.isCurrent()
      )
        return;
      const url = URL.createObjectURL(blob);
      urls.current.add(url);
      const link = document.createElement("a");
      link.href = url;
      link.download = safeAttachmentName(attachment.name);
      document.body.appendChild(link);
      try {
        link.click();
      } finally {
        link.remove();
      }
      const timer = window.setTimeout(() => {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
        timers.current.delete(timer);
      }, 1000);
      timers.current.add(timer);
    } catch (failure) {
      if (
        alive.current &&
        captured === currentKey.current &&
        latest.current.scope.isCurrent()
      )
        setError(failure instanceof Error ? failure.message : "附件下载失败。");
    } finally {
      if (alive.current && captured === currentKey.current)
        setDownloading(false);
    }
  };
  return (
    <li
      ref={host}
      className={`${styles.savedItem} ${expanded ? styles.expanded : ""}`}
    >
      {attachment.kind === "image" ? (
        preview?.key === key ? (
          <button
            type="button"
            className={styles.thumbnail}
            aria-label={`${expanded ? "收起" : "放大"}图片 ${attachment.name}`}
            onClick={() => setExpanded((value) => !value)}
          >
            <img
              src={preview.url}
              alt={attachment.name}
              onError={() => setError("图片预览失败，可下载查看。")}
            />
          </button>
        ) : (
          <span className={styles.fileBadge}>图片</span>
        )
      ) : (
        <span className={styles.fileBadge}>
          {attachment.kind === "pdf" ? "PDF" : "文"}
        </span>
      )}
      <div className={styles.savedInfo}>
        <strong>{attachment.name}</strong>
        <small>
          {attachmentSize(attachment.byteSize)}
          {attachment.pages ? ` · ${attachment.pages} 页` : ""}
        </small>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className={styles.fileActions}>
        {error && attachment.kind === "image" ? (
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            重试预览
          </button>
        ) : null}
        <button
          type="button"
          disabled={downloading}
          onClick={() => void download()}
        >
          {downloading ? "下载中…" : "下载附件"}
        </button>
      </div>
    </li>
  );
}

export function MessageAttachments({
  attachments,
  scope,
  admin = false,
  onUnauthorized,
}: {
  attachments?: FamilyAttachmentMeta[];
  scope: AttachmentScope;
  admin?: boolean;
  onUnauthorized: () => void;
}) {
  if (!attachments?.length) return null;
  return (
    <ul className={styles.savedList} aria-label="消息附件">
      {attachments.map((attachment) => (
        <SavedAttachment
          key={`${scope.key}:${attachment.id}`}
          attachment={attachment}
          scope={scope}
          admin={admin}
          onUnauthorized={onUnauthorized}
        />
      ))}
    </ul>
  );
}
