"use client";

import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./message-markdown.module.scss";

const EXTENSIONS: Record<string, string> = {
  javascript: "js",
  js: "js",
  typescript: "ts",
  ts: "ts",
  jsx: "jsx",
  tsx: "tsx",
  python: "py",
  py: "py",
  json: "json",
  html: "html",
  css: "css",
  scss: "scss",
  sql: "sql",
  yaml: "yaml",
  yml: "yml",
  markdown: "md",
  md: "md",
  bash: "sh",
  sh: "sh",
  powershell: "ps1",
  ps1: "ps1",
  c: "c",
  cpp: "cpp",
  rust: "rs",
  go: "go",
  java: "java",
  xml: "xml",
  text: "txt",
  txt: "txt",
};

function CodeBlock({
  code,
  language,
  disabled,
  canAct,
}: {
  code: string;
  language: string;
  disabled: boolean;
  canAct?: () => boolean;
}) {
  const [wrapped, setWrapped] = useState(false);
  const [status, setStatus] = useState("");
  const active = useRef(true);
  const revision = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const urls = useRef(new Set<string>());
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      revision.current++;
      for (const timer of timers.current) clearTimeout(timer);
      timers.current.clear();
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
    };
  }, []);
  useEffect(() => {
    revision.current++;
    setStatus("");
  }, [code, disabled]);
  const announce = (message: string) => {
    if (!active.current) return;
    setStatus(message);
    const version = revision.current;
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      if (active.current && version === revision.current) setStatus("");
    }, 2400);
    timers.current.add(timer);
  };
  const copy = async () => {
    if (disabled || canAct?.() === false) return;
    const version = revision.current;
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(code);
      if (active.current && version === revision.current) announce("已复制");
    } catch {
      if (active.current && version === revision.current)
        announce("复制失败，请选择代码复制");
    }
  };
  const download = () => {
    if (disabled || canAct?.() === false) return;
    let link: HTMLAnchorElement | undefined;
    try {
      const url = URL.createObjectURL(
        new Blob([code], { type: "text/plain;charset=utf-8" }),
      );
      urls.current.add(url);
      link = document.createElement("a");
      link.href = url;
      link.download = `code.${EXTENSIONS[language.toLowerCase()] ?? "txt"}`;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        if (urls.current.delete(url)) URL.revokeObjectURL(url);
      }, 0);
      timers.current.add(timer);
    } catch {
      announce("下载失败，请复制代码保存");
    } finally {
      link?.remove();
    }
  };
  return (
    <section
      className={styles.codeBlock}
      aria-label={`${language || "纯文本"}代码块`}
    >
      <div className={styles.codeHeader}>
        <span className={styles.language}>{language || "纯文本"}</span>
        <div className={styles.codeActions}>
          <button
            type="button"
            aria-pressed={wrapped}
            onClick={() => setWrapped((value) => !value)}
            aria-label="代码自动换行"
          >
            换行
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={download}
            aria-label="下载代码"
          >
            下载
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void copy()}
            aria-label="复制代码"
          >
            复制
          </button>
        </div>
      </div>
      <pre className={wrapped ? styles.wrapped : undefined} tabIndex={0}>
        <code>{code}</code>
      </pre>
      {status ? (
        <span className={styles.codeStatus} role="status">
          {status}
        </span>
      ) : null}
    </section>
  );
}

/** Markdown remains inert: no HTML, embedded resources, or automatic image requests. */
export const FamilyMarkdown = memo(function FamilyMarkdown({
  content,
  streaming = false,
  actionsDisabled = false,
  canAct,
}: {
  content: string;
  streaming?: boolean;
  actionsDisabled?: boolean;
  canAct?: () => boolean;
}) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        disallowedElements={[
          "img",
          "iframe",
          "video",
          "audio",
          "object",
          "embed",
          "script",
          "style",
          "form",
          "input",
        ]}
        components={{
          a: ({ href, children }) =>
            href && /^https?:\/\//i.test(href) ? (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          pre: ({ children }) => <>{children}</>,
          code: ({ inline, className, children }) => {
            if (inline)
              return <code className={styles.inlineCode}>{children}</code>;
            const language =
              /^language-([a-z0-9+_.#-]{1,40})$/i.exec(className ?? "")?.[1] ??
              "";
            return (
              <CodeBlock
                code={String(children).replace(/\n$/, "")}
                language={language}
                disabled={streaming || actionsDisabled}
                canAct={canAct}
              />
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
