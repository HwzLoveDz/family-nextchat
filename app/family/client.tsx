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
  type FamilyMessageRequest,
  type FamilyModel,
  type FamilyModelCatalog,
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
    public code?: string,
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
    ? `输入 ${usage.inputTokens ?? "未知"} / 输出 ${
        usage.outputTokens ?? "未知"
      } token`
    : "用量未知";
}
function modelText(message: FamilyMessage) {
  return message.model
    ? `实际模型 ${message.model}`
    : message.requestedModel
    ? `请求模型 ${message.requestedModel}（未报告实际模型）`
    : "";
}
function markdownExport(detail: FamilyChatDetail) {
  return [
    `# ${detail.chat.title || "新聊天"}`,
    "",
    "管理员可查看聊天记录与用量。以下为当前账户导出的聊天。",
    "",
    ...detail.messages.flatMap((message) => [
      `## ${message.role === "user" ? "我" : "AI"}`,
      "",
      message.content,
      "",
      ...(message.role === "assistant"
        ? [modelText(message), usageText(message.usage), ""]
        : []),
    ]),
  ].join("\n");
}

// No raw HTML, embedded resources or automatic remote image requests.
const MessageBody = memo(function MessageBody({
  message,
  userLabel = "你",
  onCopy,
  copied = false,
}: {
  message: FamilyMessage;
  userLabel?: string;
  onCopy?: (message: FamilyMessage) => void;
  copied?: boolean;
}) {
  return (
    <article
      className={`${styles.message} ${
        message.role === "user" ? styles.userMessage : ""
      }`}
    >
      <div className={styles.messageMeta}>
        <strong>{message.role === "user" ? userLabel : "AI"}</strong>
        {message.superseded ? (
          <span className={styles.badge}>旧版本</span>
        ) : null}
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
          {modelText(message) ? (
            <span className={styles.modelMeta}>{modelText(message)}</span>
          ) : null}
        </div>
      ) : null}
      {onCopy && message.content && message.status !== "streaming" ? (
        <button
          type="button"
          className={`${styles.textButton} ${styles.copyButton}`}
          onClick={() => onCopy(message)}
          aria-label={`复制${message.role === "user" ? "提问" : "回复"}`}
        >
          {copied ? "已复制" : "复制"}
        </button>
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
  const [activeChat, setActiveChat] = useState<FamilyChat | null>(null);
  const [models, setModels] = useState<FamilyModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState("");
  const [search, setSearch] = useState("");
  const [renameTitle, setRenameTitle] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [copiedMessage, setCopiedMessage] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState<string | null>(null);
  const [draftBeforeEdit, setDraftBeforeEdit] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
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
  const activeGeneration = useRef<{
    chatId: string;
    messageId: string;
    controller: AbortController;
    cancelAcknowledged: boolean;
    alreadyComplete: boolean;
    finished: boolean;
  } | null>(null);
  const cancelPendingRef = useRef(false);
  const stopPollWait = useRef<{ timer: number; resolve: () => void } | null>(
    null,
  );
  const channel = useRef<BroadcastChannel | null>(null);
  const logoutIntent = useRef(false);
  const checkSequence = useRef(0);
  const listVersion = useRef(0);
  const adminVersion = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const lastInteraction = useRef(Date.now());
  const registerRequested = useRef(false);
  const identityVerified = useRef(false);
  const defaultModel = useRef("");
  const selectedChatRef = useRef<string | null>(null);
  const composing = useRef(false);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const downloadUrls = useRef(new Set<string>());
  const downloadTimers = useRef(new Set<number>());

  const request = useCallback(
    async <T,>(
      path: string,
      init: RequestInit = {},
      timeoutMs?: number,
    ): Promise<T> => {
      const generation = epoch.current;
      const controller = new AbortController();
      controllers.current.add(controller);
      const timer = timeoutMs
        ? window.setTimeout(() => controller.abort(), timeoutMs)
        : undefined;
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
            typeof data.code === "string" ? data.code : undefined,
          );
        return data as T;
      } catch (failure) {
        if (generation !== epoch.current) throw new StaleRequest();
        throw failure;
      } finally {
        if (timer !== undefined) window.clearTimeout(timer);
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
    activeGeneration.current = null;
    cancelPendingRef.current = false;
    if (stopPollWait.current) {
      window.clearTimeout(stopPollWait.current.timer);
      stopPollWait.current.resolve();
      stopPollWait.current = null;
    }
    currentUser.current = null;
    identityVerified.current = false;
    selectedChatRef.current = null;
    defaultModel.current = "";
    composing.current = false;
    downloadTimers.current.forEach((timer) => window.clearTimeout(timer));
    downloadTimers.current.clear();
    downloadUrls.current.forEach((url) => URL.revokeObjectURL(url));
    downloadUrls.current.clear();
    setUser(null);
    setExpiresAt("");
    setChats([]);
    setSelectedChat(null);
    setMessages([]);
    setActiveChat(null);
    setModels([]);
    setSelectedModel("");
    setModelLoading(false);
    setModelError("");
    setSearch("");
    setRenameTitle(null);
    setDetailLoading(false);
    setCopiedMessage(null);
    setEditingMessage(null);
    setDraftBeforeEdit("");
    setDraft("");
    setSending(false);
    setCancelPending(false);
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
    identityVerified.current = false;
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
            currentUser.current.role !== me.user.role ||
            me.user.status !== "approved")
        )
          clearPrivate();
        currentUser.current = me.user;
        identityVerified.current = me.user.status === "approved";
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
      activeGeneration.current = null;
      cancelPendingRef.current = false;
      if (stopPollWait.current) {
        window.clearTimeout(stopPollWait.current.timer);
        stopPollWait.current.resolve();
        stopPollWait.current = null;
      }
      identityVerified.current = false;
      downloadTimers.current.forEach((timer) => window.clearTimeout(timer));
      downloadTimers.current.clear();
      downloadUrls.current.forEach((url) => URL.revokeObjectURL(url));
      downloadUrls.current.clear();
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
  const loadModels = useCallback(async () => {
    const generation = epoch.current;
    setModelLoading(true);
    setModelError("");
    try {
      const catalog = await request<FamilyModelCatalog>("/api/family/models");
      setModels(catalog.models);
      defaultModel.current = catalog.defaultModel;
      setSelectedModel((previous) => previous || catalog.defaultModel);
    } catch (failure) {
      if (!(failure instanceof StaleRequest)) setModelError(errorText(failure));
    } finally {
      if (generation === epoch.current) setModelLoading(false);
    }
  }, [request]);

  useEffect(() => {
    if (!user || user.status !== "approved" || status?.schemaReady === false)
      return;
    void loadChats().catch((failure) => {
      if (!(failure instanceof StaleRequest)) setError(errorText(failure));
    });
    void loadModels();
  }, [
    user?.id,
    user?.status,
    status?.schemaReady,
    status?.schemaVersion,
    loadChats,
    loadModels,
  ]);

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
  useEffect(() => {
    if (editingMessage && !checking) composerInput.current?.focus();
  }, [editingMessage, checking]);

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
    const generation = epoch.current;
    selectedChatRef.current = id;
    setSelectedChat(id);
    setActiveChat(null);
    setDetailLoading(true);
    setRenameTitle(null);
    setEditingMessage(null);
    setDraftBeforeEdit("");
    setArchiveConfirm(false);
    setMessages([]);
    setDraft("");
    setSidebarOpen(false);
    setError("");
    try {
      const data = await request<FamilyChatDetail>(
        `/api/family/chats/${encodeURIComponent(id)}`,
      );
      if (version === listVersion.current) {
        setMessages(data.messages);
        setActiveChat(data.chat);
        setSelectedModel(data.chat.model || defaultModel.current);
      }
    } finally {
      if (generation === epoch.current && version === listVersion.current)
        setDetailLoading(false);
    }
  };

  const acceptChat = (chat: FamilyChat) => {
    setActiveChat(chat);
    setChats((previous) =>
      previous.map((item) => (item.id === chat.id ? chat : item)),
    );
  };
  const changeModel = async (model: string) => {
    if (!models.some((item) => item.id === model)) return;
    if (selectedChat) {
      const response = await request<{ chat: FamilyChat }>(
        `/api/family/chats/${encodeURIComponent(selectedChat)}`,
        { method: "PATCH", body: JSON.stringify({ model }) },
      );
      acceptChat(response.chat);
      setSelectedModel(response.chat.model);
    } else setSelectedModel(model);
  };
  const copyMessage = useCallback(async (message: FamilyMessage) => {
    const generation = epoch.current;
    if (
      !identityVerified.current ||
      !currentUser.current ||
      message.status === "streaming"
    )
      return;
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("此浏览器暂不支持复制，可长按选中文字。");
      await navigator.clipboard.writeText(message.content);
      if (generation === epoch.current && identityVerified.current)
        setCopiedMessage(message.id);
    } catch (failure) {
      if (generation === epoch.current) setError(errorText(failure));
    }
  }, []);
  const exportChat = async () => {
    const id = selectedChat;
    const generation = epoch.current;
    const owner = currentUser.current?.id;
    if (!id || !owner || !identityVerified.current) return;
    const detail = await request<FamilyChatDetail>(
      `/api/family/chats/${encodeURIComponent(id)}`,
    );
    if (
      generation !== epoch.current ||
      !identityVerified.current ||
      currentUser.current?.id !== owner ||
      selectedChatRef.current !== id
    )
      throw new StaleRequest();
    const filename =
      (detail.chat.title || "聊天")
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/^\.+/, "")
        .trim()
        .slice(0, 70) || "聊天";
    const url = URL.createObjectURL(
      new Blob([markdownExport(detail)], {
        type: "text/markdown;charset=utf-8",
      }),
    );
    downloadUrls.current.add(url);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${filename}-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
    }
    const timer = window.setTimeout(() => {
      URL.revokeObjectURL(url);
      downloadUrls.current.delete(url);
      downloadTimers.current.delete(timer);
    }, 1000);
    downloadTimers.current.add(timer);
    setNotice("已导出当前聊天。下载的文件由你自行保管。");
  };

  const generateMessage = async (
    mode: "send" | "edit" | "retry" | "regenerate" = "send",
    sourceMessageId?: string,
  ) => {
    const content = draft.trim();
    if (
      ((mode === "send" || mode === "edit") && !content) ||
      sending ||
      checking ||
      detailLoading ||
      streamController.current ||
      cancelPendingRef.current ||
      messages.some(
        (message) =>
          message.role === "assistant" &&
          !message.superseded &&
          message.status === "streaming",
      ) ||
      !identityVerified.current ||
      (selectedChat !== null && !activeChat)
    )
      return;
    if (!models.some((model) => model.id === selectedModel)) {
      setError("请先选择一个可用模型。");
      return;
    }
    if (mode !== "send" && (!selectedChat || !sourceMessageId)) return;
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
    let accepted = false;
    try {
      if (!chatId) {
        const data = await request<{ chat: FamilyChat }>("/api/family/chats", {
          method: "POST",
          body: JSON.stringify({ model: selectedModel }),
        });
        chatId = data.chat.id;
        setChats((previous) => [data.chat, ...previous]);
        setSelectedChat(chatId);
        selectedChatRef.current = chatId;
        setActiveChat(data.chat);
      }
      if (controller.signal.aborted)
        throw new DOMException("Aborted", "AbortError");
      const requestId = crypto.randomUUID();
      const userId = `local-user-${requestId}`;
      temporaryUserId = userId;
      assistantId = `local-assistant-${requestId}`;
      const createdAt = new Date().toISOString();
      if (mode === "send")
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
      if (mode === "send" || mode === "edit") setDraft("");
      const payload: FamilyMessageRequest =
        mode === "send"
          ? { content, requestId, model: selectedModel }
          : mode === "edit"
          ? {
              content,
              requestId,
              model: selectedModel,
              mode,
              sourceMessageId: sourceMessageId!,
            }
          : {
              requestId,
              model: selectedModel,
              mode,
              sourceMessageId: sourceMessageId!,
            };
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
          body: JSON.stringify(payload),
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
          accepted = true;
          const previousAssistantId = assistantId;
          assistantId = streamEvent.assistantMessage.id;
          activeGeneration.current = {
            chatId: chatId!,
            messageId: assistantId,
            controller,
            cancelAcknowledged: false,
            alreadyComplete: false,
            finished: false,
          };
          const replaced = new Set([
            userId,
            previousAssistantId,
            ...(streamEvent.replacedMessageIds ?? []),
          ]);
          setMessages((previous) => [
            ...previous.filter((message) => !replaced.has(message.id)),
            streamEvent.userMessage,
            streamEvent.assistantMessage,
          ]);
          if (mode === "edit") {
            setEditingMessage(null);
            setDraft(draftBeforeEdit);
            setDraftBeforeEdit("");
          }
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
      const cancellation =
        activeGeneration.current?.controller === controller &&
        (activeGeneration.current.cancelAcknowledged ||
          activeGeneration.current.alreadyComplete);
      if (rejectedBeforeStream) {
        setMessages((previous) =>
          previous.filter(
            (message) =>
              message.id !== temporaryUserId && message.id !== assistantId,
          ),
        );
        if (mode === "send" || mode === "edit") setDraft(content);
      } else if (!done && !cancellation) {
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantId
              ? { ...message, status: "partial" }
              : message,
          ),
        );
      }
      setError(
        cancellation
          ? ""
          : done
          ? "回复已完成，但会话列表暂时未刷新。请稍后刷新。"
          : aborted
          ? "页面连接已断开，服务器可能仍在生成。请刷新确认记录。"
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
      const active =
        activeGeneration.current?.controller === controller
          ? activeGeneration.current
          : null;
      if (active) active.finished = true;
      if (
        generation === epoch.current &&
        accepted &&
        mode !== "send" &&
        !active?.cancelAcknowledged &&
        !active?.alreadyComplete &&
        chatId
      ) {
        try {
          const detail = await request<FamilyChatDetail>(
            `/api/family/chats/${encodeURIComponent(chatId)}`,
          );
          if (selectedChatRef.current === chatId) {
            setMessages(detail.messages);
            acceptChat(detail.chat);
            setSelectedModel(detail.chat.model || defaultModel.current);
          }
        } catch (failure) {
          if (
            generation === epoch.current &&
            !(failure instanceof StaleRequest)
          )
            setNotice("请刷新会话查看服务器保存的最新版本。");
        }
      }
      if (generation === epoch.current) setSending(false);
      if (
        active &&
        !cancelPendingRef.current &&
        activeGeneration.current === active
      )
        activeGeneration.current = null;
    }
  };

  const stopGeneration = async () => {
    const active = activeGeneration.current;
    const generation = epoch.current;
    if (!active || cancelPendingRef.current || !identityVerified.current)
      return;
    cancelPendingRef.current = true;
    setCancelPending(true);
    setError("");
    setNotice("正在向服务器请求停止…");
    try {
      try {
        await request(
          `/api/family/chats/${encodeURIComponent(
            active.chatId,
          )}/messages/${encodeURIComponent(active.messageId)}/cancel`,
          { method: "POST", body: "{}" },
          10000,
        );
        active.cancelAcknowledged = true;
      } catch (failure) {
        if (
          failure instanceof RequestError &&
          failure.status === 409 &&
          failure.code === "ALREADY_COMPLETE"
        )
          active.alreadyComplete = true;
        else throw failure;
      }
      if (generation !== epoch.current) throw new StaleRequest();
      active.controller.abort();
      setNotice("停止请求已送达，正在同步服务器记录…");
      const deadline = Date.now() + 12000;
      for (let attempt = 0; attempt < 10 && Date.now() < deadline; attempt++) {
        const detail = await request<FamilyChatDetail>(
          `/api/family/chats/${encodeURIComponent(active.chatId)}`,
          {},
          4000,
        );
        if (generation !== epoch.current) throw new StaleRequest();
        const message = detail.messages.find(
          (item) => item.id === active.messageId,
        );
        if (selectedChatRef.current === active.chatId) {
          setMessages(detail.messages);
          acceptChat(detail.chat);
        }
        if (message && message.status !== "streaming") {
          setNotice(
            message.status === "complete"
              ? "回复已经完成，停止请求未赶上本次生成。已同步实际记录与用量。"
              : "服务器已结束本次生成，已同步保存的回复与用量。",
          );
          return;
        }
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(() => {
            stopPollWait.current = null;
            resolve();
          }, 1000);
          stopPollWait.current = { timer, resolve };
        });
        if (generation !== epoch.current) throw new StaleRequest();
      }
      setError(
        "停止请求已提交，但尚未确认生成结束。请稍后刷新记录，暂勿重试回复。",
      );
      setNotice("");
    } catch (failure) {
      if (generation !== epoch.current || failure instanceof StaleRequest)
        return;
      setNotice("");
      setError(
        active.cancelAcknowledged || active.alreadyComplete
          ? "停止请求已送达，但暂时无法读取最终状态。请稍后刷新记录确认。"
          : "停止请求尚未确认，模型可能仍在生成。请重试停止或等待回复完成。",
      );
      if (
        failure instanceof RequestError &&
        [401, 403].includes(failure.status)
      )
        void checkIdentity();
    } finally {
      if (generation === epoch.current) {
        cancelPendingRef.current = false;
        setCancelPending(false);
        if (active.finished && activeGeneration.current === active)
          activeGeneration.current = null;
      }
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
  const visibleChats = chats.filter((chat) =>
    chat.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const chosenModel = models.find((model) => model.id === selectedModel);
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user" && !message.superseded);
  const lastAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && !message.superseded);
  const turnLocked =
    sending ||
    working ||
    cancelPending ||
    detailLoading ||
    lastAssistantMessage?.status === "streaming";

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
          <div className={styles.privacyNotice}>
            {screen === "login"
              ? siteNotice.replace(
                  "管理员可查看账号、聊天内容、模型回复、用量和前台活跃时长估算。",
                  "",
                )
              : siteNotice}
          </div>
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
                <>
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
                  <small>
                    请向家人管理员索取邀请链接。每个邀请仅供一人注册，注册后仍需管理员批准。
                  </small>
                </>
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

  if (status?.schemaReady === false)
    return (
      <main className={styles.shell}>
        <section className={styles.authCard}>
          <h1>{user.role === "admin" ? "更新聊天功能" : "服务正在升级"}</h1>
          <p className={styles.subtitle}>
            {user.role === "admin"
              ? "更新后即可使用模型选择与聊天编辑。账号和已有聊天会保留。"
              : "请等待管理员更新聊天功能，稍后再来。"}
          </p>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          {user.role === "admin" ? (
            <button
              disabled={working}
              onClick={() =>
                void run(async () => {
                  await request("/api/family/admin/migrate", {
                    method: "POST",
                    body: "{}",
                  });
                  await checkIdentity();
                })
              }
            >
              {working ? "正在更新…" : "更新聊天功能"}
            </button>
          ) : (
            <button disabled={checking} onClick={() => void checkIdentity()}>
              重新检查
            </button>
          )}
          <button className={styles.textButton} onClick={() => void logout()}>
            退出登录
          </button>
        </section>
      </main>
    );

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
              selectedChatRef.current = null;
              setActiveChat(null);
              setSelectedModel(defaultModel.current);
              setRenameTitle(null);
              setEditingMessage(null);
              setDraftBeforeEdit("");
              setArchiveConfirm(false);
              setMessages([]);
              setDraft("");
              setSidebarOpen(false);
              setError("");
            }}
          >
            ＋ 新聊天
          </button>
          <label className={styles.searchField}>
            <span className={styles.srOnly}>搜索聊天</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索聊天标题"
            />
          </label>
          <nav className={styles.chatList} aria-label="我的聊天">
            {visibleChats.length === 0 ? (
              <div className={styles.muted}>
                <p>{search ? "没有匹配的聊天。" : "聊天会保存到你的账户。"}</p>
                {search ? (
                  <button
                    className={styles.textButton}
                    onClick={() => setSearch("")}
                  >
                    清空搜索
                  </button>
                ) : null}
              </div>
            ) : (
              visibleChats.map((chat) => (
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
            {user.role === "admin" && screen !== "admin" ? (
              <button
                disabled={sending || working}
                onClick={() => void run(openAdmin)}
              >
                邀请家人
              </button>
            ) : null}
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
            ) : null}
          </header>
          {screen === "chat" ? (
            <div className={styles.chatToolbar}>
              <label className={styles.modelPicker}>
                <span>模型</span>
                <select
                  aria-label="选择模型"
                  value={selectedModel}
                  disabled={
                    sending ||
                    working ||
                    detailLoading ||
                    modelLoading ||
                    models.length === 0
                  }
                  onChange={(event) =>
                    void run(() => changeModel(event.target.value))
                  }
                >
                  {!chosenModel ? (
                    <option value={selectedModel}>
                      {modelLoading
                        ? "正在加载模型…"
                        : selectedModel
                        ? `${selectedModel}（不可用，请更换）`
                        : "请选择模型"}
                    </option>
                  ) : null}
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                      {model.reasoning ? " · 推理" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {chosenModel ? (
                <small className={styles.modelDescription}>
                  {chosenModel.description}
                </small>
              ) : null}
              {modelError ? (
                <div className={styles.modelError} role="alert">
                  {modelError}
                  <button
                    className={styles.textButton}
                    disabled={modelLoading}
                    onClick={() => void loadModels()}
                  >
                    重新加载模型
                  </button>
                </div>
              ) : null}
              <div className={styles.chatTools}>
                <button
                  className={styles.secondary}
                  disabled={turnLocked || !activeChat}
                  onClick={() => setRenameTitle(activeChat?.title ?? "")}
                >
                  重命名
                </button>
                <button
                  className={styles.secondary}
                  disabled={turnLocked || !activeChat}
                  onClick={() => void run(exportChat)}
                >
                  导出 Markdown
                </button>
                <button
                  className={styles.secondary}
                  disabled={sending || working || cancelPending}
                  onClick={() =>
                    void run(async () => {
                      await loadChats();
                      if (selectedChat) {
                        const detail = await request<FamilyChatDetail>(
                          `/api/family/chats/${encodeURIComponent(
                            selectedChat,
                          )}`,
                        );
                        setMessages(detail.messages);
                        acceptChat(detail.chat);
                        setSelectedModel(
                          detail.chat.model || defaultModel.current,
                        );
                      }
                    })
                  }
                >
                  刷新
                </button>
                <button
                  className={styles.secondary}
                  disabled={turnLocked || !activeChat}
                  onClick={() => setArchiveConfirm(true)}
                >
                  归档对话
                </button>
              </div>
            </div>
          ) : null}
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
          {screen === "chat" && renameTitle !== null && activeChat ? (
            <form
              className={styles.editPanel}
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const response = await request<{ chat: FamilyChat }>(
                    `/api/family/chats/${encodeURIComponent(activeChat.id)}`,
                    {
                      method: "PATCH",
                      body: JSON.stringify({ title: renameTitle.trim() }),
                    },
                  );
                  acceptChat(response.chat);
                  setRenameTitle(null);
                });
              }}
            >
              <label>
                聊天名称
                <input
                  autoFocus
                  value={renameTitle}
                  onChange={(event) => setRenameTitle(event.target.value)}
                  maxLength={80}
                  required
                  disabled={working}
                />
              </label>
              <div>
                <button disabled={working || !renameTitle.trim()}>
                  保存名称
                </button>
                <button
                  className={styles.secondary}
                  type="button"
                  disabled={working}
                  onClick={() => setRenameTitle(null)}
                >
                  取消
                </button>
              </div>
            </form>
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
                      selectedChatRef.current = null;
                      setActiveChat(null);
                      setEditingMessage(null);
                      setDraftBeforeEdit("");
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
              <section className={styles.inviteGuide}>
                <h2>邀请家人</h2>
                <p>
                  点击“生成单次邀请”，再把链接发给一位家人。每个邀请仅限一人注册，注册后你还需要在下方批准加入。
                </p>
              </section>
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
                        const generation = epoch.current;
                        if (!identityVerified.current) throw new StaleRequest();
                        await navigator.clipboard.writeText(newInvite.url);
                        if (
                          generation === epoch.current &&
                          identityVerified.current
                        )
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
                {detailLoading ? (
                  <p className={styles.muted} role="status">
                    正在加载聊天…
                  </p>
                ) : selectedChat && !activeChat ? (
                  <div className={styles.welcome}>
                    <h2>聊天暂时没有加载成功</h2>
                    <p>请点上方“刷新”重试。</p>
                  </div>
                ) : messages.length ? (
                  messages
                    .filter((message) => !message.superseded)
                    .map((message) => (
                      <div key={message.id}>
                        <MessageBody
                          message={message}
                          onCopy={copyMessage}
                          copied={copiedMessage === message.id}
                        />
                        {message.id === lastUserMessage?.id ? (
                          <div className={styles.turnActions}>
                            <button
                              className={styles.textButton}
                              disabled={turnLocked || !!editingMessage}
                              onClick={() => {
                                setDraftBeforeEdit(draft);
                                setDraft(message.content);
                                setEditingMessage(message.id);
                              }}
                            >
                              编辑上一条提问
                            </button>
                          </div>
                        ) : null}
                        {message.id === lastAssistantMessage?.id &&
                        message.status !== "streaming" ? (
                          <div className={styles.turnActions}>
                            <button
                              className={styles.textButton}
                              disabled={
                                turnLocked || !!editingMessage || !chosenModel
                              }
                              onClick={() =>
                                void generateMessage(
                                  message.status === "complete"
                                    ? "regenerate"
                                    : "retry",
                                  message.id,
                                )
                              }
                            >
                              {message.status === "complete"
                                ? "重新生成"
                                : "重试回复"}
                            </button>
                          </div>
                        ) : null}
                      </div>
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
                onSubmit={(event) => {
                  event.preventDefault();
                  void generateMessage(
                    editingMessage ? "edit" : "send",
                    editingMessage ?? undefined,
                  );
                }}
              >
                {editingMessage ? (
                  <div className={styles.editingNotice}>
                    <strong>编辑上一条提问</strong>
                    <span>将重新回复这一轮，旧版本仍由管理员保留。</span>
                    <button
                      type="button"
                      className={styles.textButton}
                      disabled={sending}
                      onClick={() => {
                        setDraft(draftBeforeEdit);
                        setDraftBeforeEdit("");
                        setEditingMessage(null);
                      }}
                    >
                      取消编辑
                    </button>
                  </div>
                ) : null}
                <label className={styles.srOnly} htmlFor="family-message">
                  发送消息
                </label>
                <textarea
                  id="family-message"
                  ref={composerInput}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={editingMessage ? "修改上一条提问…" : "输入消息…"}
                  rows={3}
                  maxLength={12000}
                  disabled={sending || checking || working || detailLoading}
                  enterKeyHint="send"
                  onCompositionStart={() => {
                    composing.current = true;
                  }}
                  onCompositionEnd={() => {
                    composing.current = false;
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing &&
                      !composing.current &&
                      event.keyCode !== 229
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <div className={styles.composerActions}>
                  <small>
                    Enter 发送 · Shift+Enter 换行
                    <br />
                    AI 回答可能有误 · 管理员可查看记录
                  </small>
                  {sending || cancelPending ? (
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={cancelPending || !activeGeneration.current}
                      onClick={() => void stopGeneration()}
                    >
                      {cancelPending
                        ? "正在停止…"
                        : activeGeneration.current
                        ? "停止回复"
                        : "正在连接…"}
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={
                        !draft.trim() ||
                        checking ||
                        working ||
                        detailLoading ||
                        cancelPending ||
                        lastAssistantMessage?.status === "streaming" ||
                        (selectedChat !== null && !activeChat) ||
                        !chosenModel
                      }
                    >
                      {editingMessage ? "保存并重新回复" : "发送 ↑"}
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
