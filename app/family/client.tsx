"use client";

import {
  type FormEvent,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  FAMILY_NOTICE,
  type FamilyAdminUser,
  type FamilyChat,
  type FamilyChatDetail,
  type FamilyMe,
  type FamilyMessage,
  type FamilySiteStatus,
  type FamilyStreamEvent,
  type FamilyUsage,
  type FamilyUser,
} from "./types";
import {
  clearLegacyFamilyData,
  FAMILY_SESSION_CHANNEL,
  FAMILY_SESSION_EVENT,
} from "./client-cleanup";
import styles from "./family.module.scss";

type Screen =
  | "loading"
  | "setup"
  | "login"
  | "register"
  | "pending"
  | "chat"
  | "admin";
class StaleRequest extends Error {}
class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "操作没有完成，请稍后重试。";
}
function dateText(value: string | null) {
  if (!value) return "尚未访问";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
function durationText(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
    : `${minutes} 分钟`;
}
function usageText(usage?: FamilyUsage) {
  return usage?.source === "reported"
    ? `输入 ${usage.inputTokens ?? 0} / 输出 ${usage.outputTokens ?? 0} token`
    : "用量未知";
}

// No raw HTML, embedded resources or automatic remote image requests.
const MessageBody = memo(function MessageBody({
  message,
  userLabel = "你",
}: {
  message: FamilyMessage;
  userLabel?: string;
}) {
  return (
    <article
      className={`${styles.message} ${
        message.role === "user" ? styles.userMessage : ""
      }`}
    >
      <div className={styles.messageMeta}>
        <strong>{message.role === "user" ? userLabel : "AI"}</strong>
        <span>
          {message.status === "streaming"
            ? "正在回复…"
            : dateText(message.createdAt)}
        </span>
      </div>
      <div className={styles.markdown}>
        {message.content ? (
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
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                  >
                    {children}
                  </a>
                ) : (
                  <span>{children}</span>
                ),
            }}
          >
            {message.content}
          </ReactMarkdown>
        ) : (
          <span className={styles.muted}>等待回复…</span>
        )}
      </div>
      {message.role === "assistant" && message.status !== "streaming" ? (
        <div className={styles.messageFoot}>
          {message.status === "partial"
            ? "回复未完成 · "
            : message.status === "error"
            ? "生成失败 · "
            : ""}
          {usageText(message.usage)}
        </div>
      ) : null}
    </article>
  );
});

async function consumeEvents(
  response: Response,
  receive: (event: FamilyStreamEvent) => void,
) {
  if (!response.body) throw new Error("无法读取回复，请刷新后查看聊天记录。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const processFrame = (frame: string) => {
    const payload = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (payload) receive(JSON.parse(payload) as FamilyStreamEvent);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        processFrame(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
      if (buffer.length > 1024 * 1024)
        throw new Error("回复数据过大，请刷新查看。");
      if (done) {
        if (buffer.trim()) processFrame(buffer);
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function FamilyApp() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [status, setStatus] = useState<FamilySiteStatus | null>(null);
  const [user, setUser] = useState<FamilyUser | null>(null);
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const [checking, setChecking] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const [inviteToken, setInviteToken] = useState("");
  const [chats, setChats] = useState<FamilyChat[]>([]);
  const [selectedChat, setSelectedChat] = useState<string | null>(null);
  const [messages, setMessages] = useState<FamilyMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [adminUsers, setAdminUsers] = useState<FamilyAdminUser[]>([]);
  const [adminSelectedUser, setAdminSelectedUser] =
    useState<FamilyAdminUser | null>(null);
  const [adminChats, setAdminChats] = useState<FamilyChat[]>([]);
  const [adminDetail, setAdminDetail] = useState<FamilyChatDetail | null>(null);
  const [newInvite, setNewInvite] = useState<{
    url: string;
    expiresAt: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const epoch = useRef(0);
  const currentUser = useRef<FamilyUser | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const streamController = useRef<AbortController | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const logoutIntent = useRef(false);
  const checkSequence = useRef(0);
  const listVersion = useRef(0);
  const adminVersion = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const lastInteraction = useRef(Date.now());
  const registerRequested = useRef(false);

  const request = useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const generation = epoch.current;
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        const response = await fetch(path, {
          ...init,
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...init.headers,
          },
        });
        const data = await response.json().catch(() => ({}));
        if (generation !== epoch.current) throw new StaleRequest();
        if (!response.ok)
          throw new RequestError(
            typeof data.error === "string"
              ? data.error
              : typeof data.message === "string"
              ? data.message
              : "请求没有完成，请稍后重试。",
            response.status,
          );
        return data as T;
      } catch (failure) {
        if (generation !== epoch.current) throw new StaleRequest();
        throw failure;
      } finally {
        controllers.current.delete(controller);
      }
    },
    [],
  );

  const clearPrivate = useCallback((preserveInvite = false) => {
    epoch.current += 1;
    listVersion.current += 1;
    adminVersion.current += 1;
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    streamController.current = null;
    currentUser.current = null;
    setUser(null);
    setExpiresAt("");
    setChats([]);
    setSelectedChat(null);
    setMessages([]);
    setDraft("");
    setSending(false);
    setArchiveConfirm(false);
    setWorking(false);
    setSidebarOpen(false);
    setAdminUsers([]);
    setAdminSelectedUser(null);
    setAdminChats([]);
    setAdminDetail(null);
    setNewInvite(null);
    setCopied(false);
    if (!preserveInvite) setInviteToken("");
    setNotice("");
  }, []);

  const checkIdentity = useCallback(async () => {
    if (logoutIntent.current) return;
    const verification = ++checkSequence.current;
    setChecking(true);
    try {
      const site = await request<FamilySiteStatus>("/api/family/status");
      if (verification !== checkSequence.current) return;
      setStatus(site);
      if (!site.dbConfigured || site.needsSetup || !site.ready) {
        clearPrivate();
        setScreen(site.dbConfigured && site.needsSetup ? "setup" : "login");
        return;
      }
      try {
        const me = await request<FamilyMe>("/api/family/me");
        if (verification !== checkSequence.current) return;
        if (
          currentUser.current &&
          (currentUser.current.id !== me.user.id ||
            me.user.status !== "approved")
        )
          clearPrivate();
        currentUser.current = me.user;
        setUser(me.user);
        setExpiresAt(me.sessionExpiresAt);
        setScreen((previous) =>
          me.user.status !== "approved"
            ? "pending"
            : previous === "admin" && me.user.role === "admin"
            ? "admin"
            : "chat",
        );
      } catch (failure) {
        if (verification !== checkSequence.current) return;
        if (
          failure instanceof RequestError &&
          [401, 403].includes(failure.status)
        ) {
          clearPrivate(!currentUser.current);
          setScreen(registerRequested.current ? "register" : "login");
          if (failure.status === 403) setError(failure.message);
        } else throw failure;
      }
    } catch (failure) {
      if (verification !== checkSequence.current) return;
      if (!(failure instanceof StaleRequest)) {
        // Do not keep private content visible after an unverified identity check.
        clearPrivate();
        setScreen("login");
        setError("暂时无法确认登录状态，请检查网络后重新登录。");
      }
    } finally {
      if (verification === checkSequence.current) setChecking(false);
    }
  }, [clearPrivate, request]);

  const broadcastChange = useCallback((kind: "login" | "logout") => {
    const event = { kind, id: crypto.randomUUID() };
    channel.current?.postMessage(event);
    try {
      localStorage.setItem(FAMILY_SESSION_EVENT, JSON.stringify(event));
      localStorage.removeItem(FAMILY_SESSION_EVENT);
    } catch {
      /* BroadcastChannel is sufficient where available. */
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = "zh-CN";
    const hash = window.location.hash;
    registerRequested.current = hash.startsWith("#/register");
    const token = registerRequested.current
      ? new URLSearchParams(hash.split("?")[1] ?? "").get("invite") ?? ""
      : "";
    if (token) {
      setInviteToken(token);
      history.replaceState(null, "", `${location.pathname}#/register`);
    }
    let active = true;
    void clearLegacyFamilyData().then(async () => {
      if (!active) return;
      await checkIdentity();
      // Identity reset clears tokens; restore only the invitation explicitly opened now.
      if (active && token && !currentUser.current) setInviteToken(token);
    });
    const verify = () => {
      if (document.visibilityState === "visible") void checkIdentity();
    };
    window.addEventListener("focus", verify);
    window.addEventListener("pageshow", verify);
    document.addEventListener("visibilitychange", verify);
    let lastEventId = "";
    const receive = (event: { kind?: string; id?: string }) => {
      if (
        !event.id ||
        event.id === lastEventId ||
        !["login", "logout"].includes(event.kind ?? "")
      )
        return;
      lastEventId = event.id;
      clearPrivate();
      setScreen("loading");
      if (event.kind === "logout") {
        logoutIntent.current = true;
        void clearLegacyFamilyData().finally(() =>
          location.replace(location.pathname),
        );
      } else void checkIdentity();
    };
    if ("BroadcastChannel" in window) {
      channel.current = new BroadcastChannel(FAMILY_SESSION_CHANNEL);
      channel.current.onmessage = (event) => receive(event.data ?? {});
    }
    const receiveStorage = (event: StorageEvent) => {
      if (event.key !== FAMILY_SESSION_EVENT || !event.newValue) return;
      try {
        receive(JSON.parse(event.newValue));
      } catch {
        /* Ignore malformed cross-tab messages. */
      }
    };
    window.addEventListener("storage", receiveStorage);
    return () => {
      active = false;
      epoch.current += 1;
      controllers.current.forEach((controller) => controller.abort());
      controllers.current.clear();
      channel.current?.close();
      channel.current = null;
      window.removeEventListener("focus", verify);
      window.removeEventListener("pageshow", verify);
      document.removeEventListener("visibilitychange", verify);
      window.removeEventListener("storage", receiveStorage);
    };
  }, [checkIdentity, clearPrivate]);

  const loadChats = useCallback(async () => {
    const data = await request<{ chats: FamilyChat[] }>("/api/family/chats");
    setChats(data.chats);
  }, [request]);

  useEffect(() => {
    if (!user || user.status !== "approved") return;
    void loadChats().catch((failure) => {
      if (!(failure instanceof StaleRequest)) setError(errorText(failure));
    });
  }, [user?.id, user?.status, loadChats]);

  useEffect(() => {
    if (!user || user.status !== "approved") return;
    lastInteraction.current = Date.now();
    const interact = () => {
      lastInteraction.current = Date.now();
    };
    const options = { passive: true };
    window.addEventListener("pointerdown", interact, options);
    window.addEventListener("keydown", interact);
    window.addEventListener("scroll", interact, {
      capture: true,
      passive: true,
    });
    const heartbeat = () => {
      if (
        document.visibilityState !== "visible" ||
        Date.now() - lastInteraction.current > 120000
      )
        return;
      void request("/api/family/activity", {
        method: "POST",
        body: JSON.stringify({ eventId: crypto.randomUUID() }),
      }).catch((failure) => {
        if (
          failure instanceof RequestError &&
          [401, 403].includes(failure.status)
        )
          void checkIdentity();
      });
    };
    heartbeat();
    const timer = window.setInterval(heartbeat, 30000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pointerdown", interact);
      window.removeEventListener("keydown", interact);
      window.removeEventListener("scroll", interact, true);
    };
  }, [user?.id, user?.status, request, checkIdentity]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const run = async (operation: () => Promise<void>) => {
    const generation = epoch.current;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (failure) {
      if (generation === epoch.current && !(failure instanceof StaleRequest)) {
        setError(errorText(failure));
        if (
          failure instanceof RequestError &&
          [401, 403].includes(failure.status) &&
          currentUser.current
        )
          void checkIdentity();
      }
    } finally {
      if (generation === epoch.current) setWorking(false);
    }
  };

  const logout = async () => {
    logoutIntent.current = true;
    clearPrivate();
    setScreen("loading");
    setError("");
    try {
      await request("/api/auth/sign-out", { method: "POST", body: "{}" });
      broadcastChange("logout");
      await clearLegacyFamilyData();
      location.replace(location.pathname);
    } catch {
      setLogoutFailed(true);
      setScreen("login");
      setError("退出尚未完成。请恢复网络后重试退出，再把设备交给其他人。");
    }
  };

  const submitAccount = (
    event: FormEvent<HTMLFormElement>,
    action: "login" | "register" | "setup",
  ) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const name = String(data.get("name") ?? "").trim();
    void run(async () => {
      try {
        if (action === "login") {
          await request("/api/auth/sign-in/email", {
            method: "POST",
            body: JSON.stringify({ email, password, rememberMe: true }),
          });
          clearPrivate();
          registerRequested.current = false;
          history.replaceState(null, "", location.pathname);
          broadcastChange("login");
          await checkIdentity();
        } else if (action === "setup") {
          await request("/api/family/setup", {
            method: "POST",
            body: JSON.stringify({
              bootstrapToken: String(data.get("bootstrapToken") ?? ""),
              name,
              email,
              password,
            }),
          });
          await checkIdentity();
          setNotice("管理员账户已创建，请登录。");
        } else {
          await request("/api/family/register", {
            method: "POST",
            body: JSON.stringify({
              inviteToken: inviteToken.trim(),
              name,
              email,
              password,
            }),
          });
          setInviteToken("");
          registerRequested.current = false;
          history.replaceState(null, "", location.pathname);
          setScreen("pending");
          setNotice(
            "注册成功，等待管理员批准后即可使用。获批后用刚才的邮箱和密码登录。",
          );
        }
      } finally {
        form.reset();
      }
    });
  };

  const selectChat = async (id: string) => {
    const version = ++listVersion.current;
    setSelectedChat(id);
    setArchiveConfirm(false);
    setMessages([]);
    setDraft("");
    setSidebarOpen(false);
    setError("");
    const data = await request<FamilyChatDetail>(
      `/api/family/chats/${encodeURIComponent(id)}`,
    );
    if (version === listVersion.current) setMessages(data.messages);
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending || checking || streamController.current) return;
    const generation = epoch.current;
    const controller = new AbortController();
    controllers.current.add(controller);
    streamController.current = controller;
    setSending(true);
    setError("");
    setNotice("");
    let chatId = selectedChat;
    let assistantId = "";
    let temporaryUserId = "";
    let done = false;
    let rejectedBeforeStream = false;
    let serverStreamError = false;
    try {
      if (!chatId) {
        const data = await request<{ chat: FamilyChat }>("/api/family/chats", {
          method: "POST",
          body: "{}",
        });
        chatId = data.chat.id;
        setChats((previous) => [data.chat, ...previous]);
        setSelectedChat(chatId);
      }
      if (controller.signal.aborted)
        throw new DOMException("Aborted", "AbortError");
      const requestId = crypto.randomUUID();
      const userId = `local-user-${requestId}`;
      temporaryUserId = userId;
      assistantId = `local-assistant-${requestId}`;
      const createdAt = new Date().toISOString();
      setMessages((previous) => [
        ...previous,
        { id: userId, role: "user", content, status: "complete", createdAt },
        {
          id: assistantId,
          role: "assistant",
          content: "",
          status: "streaming",
          createdAt,
        },
      ]);
      setDraft("");
      const response = await fetch(
        `/api/family/chats/${encodeURIComponent(chatId)}/messages`,
        {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({ content, requestId }),
        },
      );
      if (generation !== epoch.current) throw new StaleRequest();
      if (!response.ok) {
        rejectedBeforeStream = true;
        const failure = await response.json().catch(() => ({}));
        throw new RequestError(
          typeof failure.error === "string"
            ? failure.error
            : "发送失败，请刷新后重试。",
          response.status,
        );
      }
      await consumeEvents(response, (streamEvent) => {
        if (generation !== epoch.current) return;
        if (streamEvent.type === "start") {
          const previousAssistantId = assistantId;
          assistantId = streamEvent.assistantMessage.id;
          setMessages((previous) =>
            previous.map((message) =>
              message.id === userId
                ? streamEvent.userMessage
                : message.id === previousAssistantId
                ? streamEvent.assistantMessage
                : message,
            ),
          );
        } else if (streamEvent.type === "delta") {
          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantId
                ? { ...message, content: message.content + streamEvent.text }
                : message,
            ),
          );
        } else if (streamEvent.type === "done") {
          done = true;
          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantId
                ? { ...streamEvent.message, usage: streamEvent.usage }
                : message,
            ),
          );
        } else if (streamEvent.type === "error") {
          serverStreamError = true;
          throw new Error(streamEvent.message);
        }
      });
      if (!done)
        throw new Error("连接已中断，回复可能未完成。请刷新查看服务器记录。");
      if (generation === epoch.current) await loadChats();
    } catch (failure) {
      if (generation !== epoch.current || failure instanceof StaleRequest)
        return;
      const aborted = controller.signal.aborted;
      if (rejectedBeforeStream) {
        setMessages((previous) =>
          previous.filter(
            (message) =>
              message.id !== temporaryUserId && message.id !== assistantId,
          ),
        );
        setDraft(content);
      } else if (!done) {
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantId
              ? { ...message, status: "partial" }
              : message,
          ),
        );
      }
      setError(
        done
          ? "回复已完成，但会话列表暂时未刷新。请稍后刷新。"
          : aborted
          ? "已停止回复，已保存的内容以服务器聊天记录为准。"
          : errorText(failure),
      );
      if (
        serverStreamError ||
        (failure instanceof RequestError && [401, 403].includes(failure.status))
      )
        void checkIdentity();
    } finally {
      controller.abort();
      controllers.current.delete(controller);
      if (streamController.current === controller)
        streamController.current = null;
      if (generation === epoch.current) setSending(false);
    }
  };

  const openAdmin = async () => {
    const data = await request<{ users: FamilyAdminUser[] }>(
      "/api/family/admin/users",
    );
    setAdminUsers(data.users);
    setArchiveConfirm(false);
    setScreen("admin");
    setSidebarOpen(false);
  };
  const inspectUser = async (account: FamilyAdminUser) => {
    const version = ++adminVersion.current;
    setAdminSelectedUser(account);
    setAdminChats([]);
    setAdminDetail(null);
    const data = await request<{ chats: FamilyChat[] }>(
      `/api/family/admin/users/${encodeURIComponent(account.id)}/chats`,
    );
    if (version === adminVersion.current) setAdminChats(data.chats);
  };
  const inspectChat = async (id: string) => {
    const version = ++adminVersion.current;
    setAdminDetail(null);
    const detail = await request<FamilyChatDetail>(
      `/api/family/admin/chats/${encodeURIComponent(id)}`,
    );
    if (version === adminVersion.current) setAdminDetail(detail);
  };

  const siteNotice = status?.notice || FAMILY_NOTICE;
  const inputDisabled = working || logoutFailed || checking;
  const approved = user?.status === "approved";

  // Unmount private DOM during verification, including keyboard/reader targets.
  // Account-scoped state remains in memory until identity is confirmed or reset.
  if (screen === "loading" || (checking && approved))
    return (
      <main className={styles.shell}>
        <div className={styles.loading} role="status">
          {screen === "loading" ? "正在确认登录状态…" : "正在重新确认登录状态…"}
        </div>
      </main>
    );

  if (!approved || !["chat", "admin"].includes(screen)) {
    const setup = screen === "setup";
    const register = screen === "register";
    const pending = screen === "pending";
    return (
      <main className={styles.shell}>
        <div className={styles.authCard}>
          <div className={styles.eyebrow}>FAMILY CHAT</div>
          <h1>
            {setup
              ? "创建管理员账户"
              : register
              ? "加入家庭聊天"
              : pending
              ? user?.status === "disabled"
                ? "账户已停用"
                : "等待管理员批准"
              : "家人的 AI 小站"}
          </h1>
          <p className={styles.subtitle}>
            {setup
              ? "首次使用，请由网站管理员完成初始化。"
              : "一个只对受邀家人开放的聊天空间。"}
          </p>
          <div className={styles.privacyNotice}>{siteNotice}</div>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className={styles.success} role="status">
              {notice}
            </p>
          ) : null}
          {!status?.dbConfigured ||
          (status && !status.ready && !status.needsSetup) ? (
            <div className={styles.empty}>
              <p>网站还没有准备好，请联系管理员。</p>
              <button onClick={() => void checkIdentity()}>重新检查</button>
            </div>
          ) : pending ? (
            <div className={styles.authActions}>
              <p>
                {user?.status === "disabled"
                  ? "如需恢复使用，请联系管理员。"
                  : "获批后才能聊天。你可以稍后回来登录。"}
              </p>
              {user ? (
                <button
                  disabled={checking}
                  onClick={() => void checkIdentity()}
                >
                  检查审批状态
                </button>
              ) : (
                <button
                  onClick={() => {
                    setScreen("login");
                    setNotice("");
                  }}
                >
                  返回登录
                </button>
              )}
              {user ? (
                <button
                  className={styles.secondary}
                  onClick={() => void logout()}
                >
                  退出登录
                </button>
              ) : null}
            </div>
          ) : logoutFailed ? (
            <button onClick={() => void logout()}>重试退出登录</button>
          ) : (
            <form
              onSubmit={(event) =>
                submitAccount(
                  event,
                  setup ? "setup" : register ? "register" : "login",
                )
              }
              className={styles.authForm}
            >
              {setup ? (
                <label>
                  初始化口令
                  <input
                    name="bootstrapToken"
                    type="password"
                    autoComplete="off"
                    required
                    disabled={inputDisabled}
                  />
                </label>
              ) : null}
              {register ? (
                <label>
                  邀请口令
                  <input
                    value={inviteToken}
                    onChange={(event) => setInviteToken(event.target.value)}
                    autoComplete="off"
                    required
                    maxLength={512}
                    disabled={inputDisabled}
                    spellCheck={false}
                  />
                </label>
              ) : null}
              {setup || register ? (
                <label>
                  称呼
                  <input
                    name="name"
                    autoComplete="name"
                    required
                    maxLength={64}
                    disabled={inputDisabled}
                  />
                </label>
              ) : null}
              <label>
                邮箱
                <input
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  maxLength={254}
                  disabled={inputDisabled}
                  inputMode="email"
                />
              </label>
              <label>
                密码
                <input
                  name="password"
                  type="password"
                  autoComplete={
                    setup || register ? "new-password" : "current-password"
                  }
                  required
                  minLength={setup || register ? 12 : 1}
                  maxLength={128}
                  disabled={inputDisabled}
                />
              </label>
              {setup || register ? (
                <small>请设置至少 12 位密码，不要与其他网站共用。</small>
              ) : (
                <small>
                  默认在此设备保持登录 30 天；共用设备使用后请退出。
                </small>
              )}
              <button type="submit" disabled={inputDisabled}>
                {working
                  ? "请稍候…"
                  : setup
                  ? "创建管理员"
                  : register
                  ? "注册并申请加入"
                  : "登录"}
              </button>
              {!setup ? (
                <button
                  type="button"
                  className={styles.textButton}
                  disabled={working}
                  onClick={() => {
                    registerRequested.current = !register;
                    setScreen(register ? "login" : "register");
                    setError("");
                    setNotice("");
                    history.replaceState(
                      null,
                      "",
                      register
                        ? location.pathname
                        : `${location.pathname}#/register`,
                    );
                  }}
                >
                  {register ? "已有账户，返回登录" : "有邀请？申请加入"}
                </button>
              ) : null}
            </form>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <div className={styles.app}>
        <aside
          className={`${styles.sidebar} ${
            sidebarOpen ? styles.sidebarOpen : ""
          }`}
        >
          <div className={styles.sidebarBrand}>
            <strong>家人的 AI 小站</strong>
            <button
              className={styles.mobileOnly}
              aria-label="关闭会话列表"
              onClick={() => setSidebarOpen(false)}
            >
              关闭
            </button>
          </div>
          <button
            disabled={sending || working}
            onClick={() => {
              ++listVersion.current;
              setScreen("chat");
              setSelectedChat(null);
              setArchiveConfirm(false);
              setMessages([]);
              setDraft("");
              setSidebarOpen(false);
              setError("");
            }}
          >
            ＋ 新聊天
          </button>
          <nav className={styles.chatList} aria-label="我的聊天">
            {chats.length === 0 ? (
              <p className={styles.muted}>聊天会保存到你的账户。</p>
            ) : (
              chats.map((chat) => (
                <button
                  key={chat.id}
                  className={
                    selectedChat === chat.id && screen === "chat"
                      ? styles.activeChat
                      : ""
                  }
                  disabled={sending || working}
                  onClick={() => {
                    setScreen("chat");
                    void run(() => selectChat(chat.id));
                  }}
                >
                  <span>{chat.title || "新聊天"}</span>
                  <small>
                    {new Date(chat.updatedAt).toLocaleDateString("zh-CN")}
                  </small>
                </button>
              ))
            )}
          </nav>
          <div className={styles.account}>
            <strong>{user.name}</strong>
            <span>{user.email}</span>
            {expiresAt ? (
              <small>
                登录有效至 {new Date(expiresAt).toLocaleDateString("zh-CN")}
              </small>
            ) : null}
            {user.role === "admin" ? (
              <button
                className={styles.secondary}
                disabled={sending || working}
                onClick={() => void run(openAdmin)}
              >
                账户与用量管理
              </button>
            ) : null}
            <button className={styles.secondary} onClick={() => void logout()}>
              退出登录
            </button>
          </div>
        </aside>
        {sidebarOpen ? (
          <button
            className={styles.backdrop}
            aria-label="关闭会话列表"
            onClick={() => setSidebarOpen(false)}
          />
        ) : null}
        <section className={styles.main}>
          <header className={styles.header}>
            <button
              className={styles.mobileOnly}
              aria-label="打开会话列表"
              onClick={() => setSidebarOpen(true)}
            >
              会话
            </button>
            <div>
              <h1>
                {screen === "admin"
                  ? "账户与用量管理"
                  : chats.find((chat) => chat.id === selectedChat)?.title ||
                    "新聊天"}
              </h1>
              <p>管理员可查看聊天记录与用量</p>
            </div>
            {screen === "admin" ? (
              <button
                className={styles.secondary}
                onClick={() => {
                  setScreen("chat");
                  setAdminDetail(null);
                  setNewInvite(null);
                }}
              >
                返回聊天
              </button>
            ) : selectedChat ? (
              <>
                <button
                  className={styles.secondary}
                  disabled={sending || working}
                  onClick={() => void run(() => selectChat(selectedChat))}
                >
                  刷新
                </button>
                <button
                  className={styles.secondary}
                  disabled={sending || working}
                  onClick={() => setArchiveConfirm(true)}
                >
                  归档对话
                </button>
              </>
            ) : null}
          </header>
          {error ? (
            <div className={styles.bannerError} role="alert">
              {error}
            </div>
          ) : null}
          {notice ? (
            <div className={styles.bannerSuccess} role="status">
              {notice}
            </div>
          ) : null}
          {screen === "chat" && selectedChat && archiveConfirm ? (
            <div className={styles.archivePrompt}>
              <p>归档后从你的列表隐藏，管理员仍可查看。</p>
              <div>
                <button
                  disabled={working || sending}
                  onClick={() =>
                    void run(async () => {
                      await request(
                        `/api/family/chats/${encodeURIComponent(selectedChat)}`,
                        { method: "DELETE" },
                      );
                      ++listVersion.current;
                      setSelectedChat(null);
                      setMessages([]);
                      setDraft("");
                      setArchiveConfirm(false);
                      await loadChats();
                      setNotice("对话已归档，管理员仍可查看。");
                    })
                  }
                >
                  确认归档
                </button>
                <button
                  className={styles.secondary}
                  disabled={working}
                  onClick={() => setArchiveConfirm(false)}
                >
                  取消
                </button>
              </div>
            </div>
          ) : null}
          {screen === "admin" ? (
            <div className={styles.adminContent}>
              <div className={styles.adminToolbar}>
                <p>仅统计前台可见且最近有操作的活跃时长，属于估算。</p>
                <div>
                  <button
                    disabled={working}
                    onClick={() => void run(openAdmin)}
                  >
                    刷新统计
                  </button>
                  <button
                    disabled={working}
                    onClick={() =>
                      void run(async () => {
                        const invitation = await request<{
                          inviteToken: string;
                          expiresAt: string;
                        }>("/api/family/admin/invites", {
                          method: "POST",
                          body: JSON.stringify({ expiresInDays: 7 }),
                        });
                        setNewInvite({
                          url: `${location.origin}${
                            location.pathname
                          }#/register?invite=${encodeURIComponent(
                            invitation.inviteToken,
                          )}`,
                          expiresAt: invitation.expiresAt,
                        });
                        setCopied(false);
                      })
                    }
                  >
                    生成单次邀请
                  </button>
                </div>
              </div>
              {newInvite ? (
                <div className={styles.invite}>
                  <strong>
                    单次邀请，有效至 {dateText(newInvite.expiresAt)}
                  </strong>
                  <p>只发给准备邀请的家人；注册后仍需你审批。</p>
                  <textarea
                    aria-label="邀请链接"
                    readOnly
                    value={newInvite.url}
                    rows={3}
                  />
                  <button
                    onClick={() =>
                      void run(async () => {
                        await navigator.clipboard.writeText(newInvite.url);
                        setCopied(true);
                      })
                    }
                  >
                    {copied ? "已复制" : "复制邀请链接"}
                  </button>
                  <button
                    className={styles.textButton}
                    onClick={() => setNewInvite(null)}
                  >
                    收起
                  </button>
                </div>
              ) : null}
              <div className={styles.userGrid}>
                {adminUsers.map((account) => (
                  <article className={styles.userCard} key={account.id}>
                    <div>
                      <strong>{account.name}</strong>
                      <span className={styles.badge}>
                        {account.role === "admin"
                          ? "管理员"
                          : account.status === "pending"
                          ? "待审批"
                          : account.status === "disabled"
                          ? "已停用"
                          : "已批准"}
                      </span>
                    </div>
                    <p>{account.email}</p>
                    <dl>
                      <dt>前台活跃估算</dt>
                      <dd>{durationText(account.activeSeconds)}</dd>
                      <dt>已报告输入 / 输出 token</dt>
                      <dd>
                        {account.inputTokens.toLocaleString()} /{" "}
                        {account.outputTokens.toLocaleString()}
                      </dd>
                      <dt>用量未知的请求</dt>
                      <dd>{account.unknownUsageRequests}</dd>
                      <dt>最近访问</dt>
                      <dd>{dateText(account.lastSeenAt)}</dd>
                    </dl>
                    <div className={styles.cardActions}>
                      <button
                        disabled={working}
                        onClick={() => void run(() => inspectUser(account))}
                      >
                        查看完整聊天
                      </button>
                      {account.role !== "admin" ? (
                        <button
                          className={
                            account.status === "approved"
                              ? styles.danger
                              : styles.secondary
                          }
                          disabled={working}
                          onClick={() =>
                            void run(async () => {
                              await request(
                                `/api/family/admin/users/${encodeURIComponent(
                                  account.id,
                                )}`,
                                {
                                  method: "PATCH",
                                  body: JSON.stringify({
                                    status:
                                      account.status === "approved"
                                        ? "disabled"
                                        : "approved",
                                  }),
                                },
                              );
                              await openAdmin();
                            })
                          }
                        >
                          {account.status === "approved"
                            ? "停用账户"
                            : account.status === "pending"
                            ? "批准加入"
                            : "恢复账户"}
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
              {adminSelectedUser ? (
                <section className={styles.inspection}>
                  <h2>{adminSelectedUser.name}的聊天记录</h2>
                  <div className={styles.inspectChats}>
                    {adminChats.length ? (
                      adminChats.map((chat) => (
                        <button
                          className={
                            adminDetail?.chat.id === chat.id
                              ? styles.activeChat
                              : styles.secondary
                          }
                          key={chat.id}
                          disabled={working}
                          onClick={() => void run(() => inspectChat(chat.id))}
                        >
                          <span>
                            {chat.title || "新聊天"}
                            {chat.archived ? " · 已归档" : ""}
                          </span>
                          <small>{dateText(chat.updatedAt)}</small>
                        </button>
                      ))
                    ) : (
                      <p className={styles.muted}>暂无聊天。</p>
                    )}
                  </div>
                  {adminDetail ? (
                    <div className={styles.inspectedMessages}>
                      <h3>
                        {adminDetail.chat.title}
                        {adminDetail.chat.archived ? (
                          <span className={styles.badge}>已归档</span>
                        ) : null}
                      </h3>
                      {adminDetail.messages.length ? (
                        adminDetail.messages.map((message) => (
                          <MessageBody
                            key={message.id}
                            message={message}
                            userLabel={adminSelectedUser.name}
                          />
                        ))
                      ) : (
                        <p>这个会话还没有消息。</p>
                      )}
                    </div>
                  ) : null}
                </section>
              ) : null}
            </div>
          ) : (
            <>
              <div
                className={styles.messages}
                aria-label="聊天记录"
                aria-busy={sending}
              >
                {messages.length ? (
                  messages.map((message) => (
                    <MessageBody key={message.id} message={message} />
                  ))
                ) : (
                  <div className={styles.welcome}>
                    <span className={styles.welcomeIcon}>聊</span>
                    <h2>想聊点什么？</h2>
                    <p>问问题、理思路，或者分享今天的新鲜事。</p>
                    <p className={styles.muted}>
                      聊天保存在你的账户中，管理员可查看记录与用量。
                    </p>
                  </div>
                )}
                <div ref={bottom} />
              </div>
              <form
                className={styles.composer}
                onSubmit={(event) => void sendMessage(event)}
              >
                <label className={styles.srOnly} htmlFor="family-message">
                  发送消息
                </label>
                <textarea
                  id="family-message"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="输入消息…"
                  rows={3}
                  maxLength={12000}
                  disabled={sending || checking || working}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing &&
                      window.matchMedia("(min-width: 769px)").matches
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <div className={styles.composerActions}>
                  <small>AI 回答可能有误 · 管理员可查看记录</small>
                  {sending ? (
                    <button
                      type="button"
                      className={styles.secondary}
                      onClick={() => streamController.current?.abort()}
                    >
                      停止回复
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!draft.trim() || checking || working}
                    >
                      发送 ↑
                    </button>
                  )}
                </div>
              </form>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
