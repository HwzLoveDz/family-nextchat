"use client";

import {
  type FormEvent,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { FamilyMarkdown } from "./message-markdown";
import { FamilySettings } from "./family-settings";
import { FamilyIcon } from "./icons";
import { modelDescription } from "./model-descriptions";
import { ProviderAdminPanel } from "./provider-admin-panel";
import type { ProviderAdminSnapshot } from "./provider-admin-types";
import { UsageDashboard } from "./usage-dashboard";
import type { UsageDashboardData } from "./usage-dashboard-types";
import { useWorkspacePreferences } from "./use-workspace-preferences";
import type {
  FamilyFilePage,
  FamilyFileSummary,
  FamilySessionSummary,
} from "./workspace-types";
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
import { useFamilyVoice, type VoiceScope } from "./use-family-voice";
import { useFamilyRealtime } from "./use-family-realtime";
import { RealtimePanel } from "./realtime-panel";
import { useFamilyViewport } from "./use-family-viewport";
import { useFamilyTheme } from "./use-family-theme";
import { ThemeSettings } from "./theme-settings";
import { ImageGenerationControls } from "./image-controls";
import {
  DEFAULT_IMAGE_OPTIONS,
  FAMILY_IMAGE_QUALITIES,
  FAMILY_IMAGE_SIZES,
  type FamilyImageOptions,
} from "./image-types";
import {
  AttachmentComposer,
  MessageAttachments,
  useDraftAttachments,
  type AttachmentScope,
} from "./attachments";
import {
  attachmentModelError,
  attachmentSize,
  ATTACHMENT_LIMITS,
  encodeAttachmentInputs,
} from "./attachment-browser";

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
function withinVoiceButton(event: {
  currentTarget: HTMLButtonElement;
  clientX: number;
  clientY: number;
}) {
  const rect = event.currentTarget.getBoundingClientRect();
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
}
function modelText(message: FamilyMessage) {
  return message.model
    ? `实际模型 ${message.model}`
    : message.requestedModel
    ? `请求模型 ${message.requestedModel}（未报告实际模型）`
    : "";
}
function imageOptionsFromMessages(
  messages: FamilyMessage[],
): FamilyImageOptions {
  const options = [...messages]
    .reverse()
    .find((message) => !message.superseded && message.imageOptions)
    ?.imageOptions;
  return options &&
    FAMILY_IMAGE_SIZES.includes(options.size) &&
    FAMILY_IMAGE_QUALITIES.includes(options.quality)
    ? { ...options }
    : { ...DEFAULT_IMAGE_OPTIONS };
}
function markdownExport(detail: FamilyChatDetail) {
  return [
    `# ${detail.chat.title || "新聊天"}`,
    "",
    "以下为当前账户导出的聊天。",
    "",
    ...detail.messages.flatMap((message) => [
      `## ${message.role === "user" ? "我" : "AI"}`,
      "",
      message.content,
      "",
      ...(message.attachments?.length
        ? [
            "附件信息（文件内容未打包）：",
            ...message.attachments.map(
              (attachment) =>
                `- ${attachment.name
                  .replace(/[\r\n]/g, " ")
                  .replace(/[\\`*_\[\]{}()#+!|>-]/g, "\\$&")} · ${
                  attachment.mediaType
                } · ${attachmentSize(attachment.byteSize)}`,
            ),
            "",
          ]
        : []),
      ...(message.imageOptions
        ? [
            `图片生成设置：${message.imageOptions.size} / ${message.imageOptions.quality}`,
            "",
          ]
        : []),
      ...(message.generatedImages?.length
        ? [
            "生成的图片（文件内容未打包）：",
            ...message.generatedImages.map(
              (image) =>
                `- ${image.name
                  .replace(/[\r\n]/g, " ")
                  .replace(/[\\`*_\[\]{}()#+!|>-]/g, "\\$&")} · ${
                  image.width
                } × ${image.height} · ${image.mediaType} · ${attachmentSize(
                  image.byteSize,
                )}`,
            ),
            "",
          ]
        : []),
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
  onSpeak,
  speechDisabled = false,
  attachmentScope,
  attachmentAdmin = false,
  onAttachmentUnauthorized = () => {},
}: {
  message: FamilyMessage;
  userLabel?: string;
  onCopy?: (message: FamilyMessage) => void;
  copied?: boolean;
  onSpeak?: (message: FamilyMessage) => void;
  speechDisabled?: boolean;
  attachmentScope?: AttachmentScope;
  attachmentAdmin?: boolean;
  onAttachmentUnauthorized?: () => void;
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
            ? message.requestedModel?.startsWith("gpt-image-")
              ? "正在生成图片…"
              : "正在回复…"
            : dateText(message.createdAt)}
        </span>
      </div>
      <div className={styles.markdown}>
        {message.content ? (
          <FamilyMarkdown
            content={message.content}
            streaming={message.status === "streaming"}
            actionsDisabled={!onCopy || attachmentScope?.readable === false}
            canAct={attachmentScope?.isCurrent}
          />
        ) : (
          <span className={styles.muted}>
            {message.role === "user" && message.attachments?.length
              ? "已发送附件"
              : message.generatedImages?.length
              ? "图片已生成"
              : message.requestedModel?.startsWith("gpt-image-") &&
                message.status === "streaming"
              ? "正在生成图片…"
              : "等待回复…"}
          </span>
        )}
      </div>
      {attachmentScope ? (
        <MessageAttachments
          attachments={message.attachments}
          scope={attachmentScope}
          admin={attachmentAdmin}
          onUnauthorized={onAttachmentUnauthorized}
        />
      ) : null}
      {attachmentScope && message.generatedImages?.length ? (
        <MessageAttachments
          attachments={message.generatedImages.map((image) => ({
            ...image,
            kind: "image" as const,
          }))}
          source="generated"
          scope={attachmentScope}
          admin={attachmentAdmin}
          onUnauthorized={onAttachmentUnauthorized}
        />
      ) : null}
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
      {onSpeak &&
      message.role === "assistant" &&
      ["complete", "partial"].includes(message.status) &&
      message.content &&
      !message.superseded ? (
        <button
          type="button"
          className={`${styles.textButton} ${styles.copyButton}`}
          disabled={speechDisabled}
          onClick={() => onSpeak(message)}
          aria-label="朗读回复"
        >
          朗读 · AI声音
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
  useFamilyViewport();
  const appearance = useFamilyTheme();
  const { preferences, setPreferences } = useWorkspacePreferences();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<
    "chat" | "files" | "usage"
  >("chat");
  const [archivedView, setArchivedView] = useState(false);
  const [nextChatCursor, setNextChatCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const [files, setFiles] = useState<FamilyFileSummary[]>([]);
  const [fileSearch, setFileSearch] = useState("");
  const [fileCursor, setFileCursor] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [followLatest, setFollowLatest] = useState(true);
  const searchInput = useRef<HTMLInputElement>(null);
  const messagesHost = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const searchVersion = useRef(0);
  const filesVersion = useRef(0);
  const chatQuery = useRef({ search: "", archivedView: false });

  const [screen, setScreen] = useState<Screen>("loading");
  const [status, setStatus] = useState<FamilySiteStatus | null>(null);
  const [user, setUser] = useState<FamilyUser | null>(null);
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const [checking, setChecking] = useState(false);
  const [identityBlocked, setIdentityBlocked] = useState(false);
  const [identityWarning, setIdentityWarning] = useState("");
  const [logoutFailed, setLogoutFailed] = useState(false);
  const [inviteToken, setInviteToken] = useState("");
  const [chats, setChats] = useState<FamilyChat[]>([]);
  const [selectedChat, setSelectedChat] = useState<string | null>(null);
  const [messages, setMessages] = useState<FamilyMessage[]>([]);
  const [activeChat, setActiveChat] = useState<FamilyChat | null>(null);
  const [models, setModels] = useState<FamilyModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [imageOptions, setImageOptions] = useState<FamilyImageOptions>(() => ({
    ...DEFAULT_IMAGE_OPTIONS,
  }));
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState("");
  const [search, setSearch] = useState("");
  chatQuery.current = { search, archivedView };
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
  const [autoReadVoice, setAutoReadVoice] = useState(true);
  const [tapRecord, setTapRecord] = useState(false);
  const [voiceOutside, setVoiceOutside] = useState(false);

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
  const identityCheck = useRef<Promise<void> | null>(null);
  const lastBackgroundCheck = useRef(-Infinity);
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
  const attachmentReset = useRef<() => void>(() => {});
  const attachmentEpoch = epoch.current;
  const attachmentOwner = currentUser.current?.id;
  const draftAttachments = useDraftAttachments(
    {
      key: `${attachmentEpoch}:${attachmentOwner}:${selectedChat}`,
      isCurrent: () =>
        attachmentEpoch === epoch.current &&
        attachmentOwner === currentUser.current?.id,
    },
    (message) => setError(message),
  );
  attachmentReset.current = draftAttachments.clear;
  const voiceReset = useRef<() => void>(() => {});
  const realtimeReset = useRef<() => void>(() => {});
  const realtimeBusy = useRef(false);
  const realtimeFinished = useRef<(chatId: string) => void>(() => {});
  const realtimeSyncTimer = useRef<number | null>(null);
  const realtimeSyncVersion = useRef(0);
  const voiceSubmit = useRef<
    (text: string, scope: VoiceScope) => void | Promise<void>
  >(() => {});
  const voiceRevalidate = useRef<() => void>(() => {});
  const autoReadVoiceRef = useRef(true);
  autoReadVoiceRef.current = autoReadVoice;
  const voice = useFamilyVoice({
    getScope: () => ({
      epoch: epoch.current,
      userId: currentUser.current?.id ?? null,
      chatId: selectedChatRef.current,
      model: selectedModel,
      verified: identityVerified.current,
      canRecord:
        screen === "chat" &&
        !draft.trim() &&
        !draftAttachments.hasAny() &&
        !editingMessage &&
        !sending &&
        !cancelPending &&
        !working &&
        !checking &&
        !realtimeBusy.current &&
        !detailLoading &&
        status?.schemaReady !== false &&
        models.some(
          (model) => model.id === selectedModel && model.kind !== "image",
        ),
    }),
    onTranscript: (text, scope) => voiceSubmit.current(text, scope),
    onError: (message) => setError(message),
    onUnauthorized: () => voiceRevalidate.current(),
  });
  voiceReset.current = voice.reset;
  const realtime = useFamilyRealtime({
    getScope: () => ({
      epoch: epoch.current,
      userId: currentUser.current?.id ?? null,
      chatId: selectedChatRef.current,
      verified: identityVerified.current,
      canStart:
        screen === "chat" &&
        !models.some(
          (model) => model.id === selectedModel && model.kind === "image",
        ) &&
        !voice.busy &&
        !sending &&
        !working &&
        !checking &&
        !cancelPending &&
        !detailLoading &&
        !editingMessage &&
        !draftAttachments.preparing &&
        status?.schemaReady !== false &&
        !messages.some(
          (message) =>
            message.role === "assistant" &&
            message.status === "streaming" &&
            !message.superseded,
        ),
    }),
    onError: (message) => setError(message),
    onUnauthorized: () => voiceRevalidate.current(),
    onFinished: (chatId) => realtimeFinished.current(chatId),
  });
  realtimeReset.current = realtime.reset;
  realtimeBusy.current = realtime.busy;

  const request = useCallback(
    async <T,>(
      path: string,
      init: RequestInit = {},
      timeoutMs = 15000,
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
    attachmentReset.current();
    voiceReset.current();
    realtimeReset.current();
    realtimeSyncVersion.current++;
    if (realtimeSyncTimer.current !== null)
      window.clearTimeout(realtimeSyncTimer.current);
    realtimeSyncTimer.current = null;
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
    setSettingsOpen(false);
    setWorkspaceMode("chat");
    setArchivedView(false);
    setNextChatCursor(null);
    setListLoading(false);
    searchVersion.current++;
    filesVersion.current++;
    setFiles([]);
    setFileSearch("");
    setFileCursor(null);
    setFileLoading(false);
    setHasOlderMessages(false);
    setOlderCursor(null);
    setOlderLoading(false);
    followMessages.current = true;
    setFollowLatest(true);
    setChats([]);
    setSelectedChat(null);
    setMessages([]);
    setActiveChat(null);
    setModels([]);
    setSelectedModel("");
    setImageOptions({ ...DEFAULT_IMAGE_OPTIONS });
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
    setAutoReadVoice(true);
    setTapRecord(false);
    setVoiceOutside(false);
    if (!preserveInvite) setInviteToken("");
    setNotice("");
    setIdentityWarning("");
    setIdentityBlocked(false);
  }, []);

  const checkIdentity = useCallback(
    (options: { background?: boolean; force?: boolean } = {}) => {
      if (logoutIntent.current) return Promise.resolve();
      if (options.background && identityCheck.current)
        return identityCheck.current;
      if (
        options.background &&
        !options.force &&
        Date.now() - lastBackgroundCheck.current < 2000
      )
        return Promise.resolve();
      if (options.background) lastBackgroundCheck.current = Date.now();
      const verification = ++checkSequence.current;
      const background = !!options.background && !!currentUser.current;
      if (!background) {
        voiceReset.current();
        realtimeReset.current();
        setIdentityBlocked(!!currentUser.current);
      }
      // Keep the editor mounted during routine probes, but do not send private
      // operations until the cookie's current identity has been confirmed.
      identityVerified.current = false;
      setChecking(true);
      const deadline = Date.now() + 10000;
      const timeout = () => Math.max(1, deadline - Date.now());
      const pending = (async () => {
        try {
          const site = await request<FamilySiteStatus>(
            "/api/family/status",
            {},
            timeout(),
          );
          if (verification !== checkSequence.current) return;
          if (!site.dbConfigured || site.needsSetup || !site.ready) {
            // A cold database or temporary outage is not evidence of logout.
            if (currentUser.current) throw new Error("账号服务暂时不可用");
            setStatus(site);
            clearPrivate();
            setScreen(site.dbConfigured && site.needsSetup ? "setup" : "login");
            return;
          }
          setStatus(site);
          try {
            const me = await request<FamilyMe>("/api/family/me", {}, timeout());
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
            setIdentityBlocked(false);
            setIdentityWarning("");
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
            if (currentUser.current) {
              // Preserve account-scoped RAM on transport/service failures. Actions
              // stay locked; a hard auth failure also keeps the private DOM hidden.
              setIdentityWarning(
                "登录状态暂时无法刷新，草稿和附件已保留。请检查网络后重试。",
              );
            } else {
              setScreen("login");
              setError("暂时无法确认登录状态，请检查网络后重试。");
            }
          }
        } finally {
          if (verification === checkSequence.current) {
            identityCheck.current = null;
            setChecking(false);
          }
        }
      })();
      identityCheck.current = pending;
      return pending;
    },
    [clearPrivate, request],
  );
  voiceRevalidate.current = () => {
    void checkIdentity();
  };

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
      if (document.visibilityState === "visible")
        void checkIdentity({ background: true });
    };
    window.addEventListener("focus", verify);
    window.addEventListener("pageshow", verify);
    window.addEventListener("online", verify);
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
      checkSequence.current++;
      identityCheck.current = null;
      epoch.current += 1;
      attachmentReset.current();
      voiceReset.current();
      realtimeReset.current();
      realtimeSyncVersion.current++;
      if (realtimeSyncTimer.current !== null)
        window.clearTimeout(realtimeSyncTimer.current);
      realtimeSyncTimer.current = null;
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
      window.removeEventListener("online", verify);
      document.removeEventListener("visibilitychange", verify);
      window.removeEventListener("storage", receiveStorage);
    };
  }, [checkIdentity, clearPrivate]);

  const loadChats = useCallback(
    async (cursor?: string) => {
      if (!identityVerified.current) return;
      const version = ++searchVersion.current;
      const query = chatQuery.current;
      const params = new URLSearchParams();
      if (query.search.trim()) params.set("q", query.search.trim());
      if (query.archivedView) params.set("view", "archived");
      if (cursor) params.set("cursor", cursor);
      setListLoading(true);
      try {
        const data = await request<{
          chats: FamilyChat[];
          nextCursor?: string | null;
        }>(`/api/family/chats${params.toString() ? `?${params}` : ""}`);
        if (version !== searchVersion.current || !identityVerified.current)
          return;
        setChats((previous) =>
          cursor
            ? [
                ...previous,
                ...data.chats.filter(
                  (chat) => !previous.some((old) => old.id === chat.id),
                ),
              ]
            : data.chats,
        );
        setNextChatCursor(data.nextCursor ?? null);
      } finally {
        if (version === searchVersion.current) setListLoading(false);
      }
    },
    [request],
  );
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
    if (!user || user.status !== "approved" || status?.schemaReady === false)
      return;
    // Invalidate immediately, before debounce, so old search results cannot win.
    searchVersion.current++;
    const timer = window.setTimeout(
      () => {
        void loadChats().catch((failure) => {
          if (!(failure instanceof StaleRequest)) setError(errorText(failure));
        });
      },
      search.trim() ? 250 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [
    user?.id,
    user?.status,
    status?.schemaReady,
    status?.schemaVersion,
    checking,
    search,
    archivedView,
    loadChats,
  ]);

  useEffect(() => {
    if (followMessages.current)
      bottom.current?.scrollIntoView({ block: "end" });
  }, [messages]);
  useEffect(() => {
    if (editingMessage && !checking) composerInput.current?.focus();
  }, [editingMessage, checking]);

  const run = async (operation: () => Promise<void>) => {
    if (realtimeBusy.current) return;
    if (currentUser.current && !identityVerified.current) return;
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
    if (id === selectedChatRef.current && activeChat?.id === id) {
      setWorkspaceMode("chat");
      setSidebarOpen(false);
      return;
    }
    if (
      (draft.trim() || draftAttachments.hasAny() || editingMessage) &&
      !window.confirm("当前有未发送的内容。放弃草稿和附件，切换聊天？")
    )
      return;
    setWorkspaceMode("chat");
    followMessages.current = true;
    setFollowLatest(true);
    setHasOlderMessages(false);
    setOlderCursor(null);
    setOlderLoading(false);
    attachmentReset.current();
    voiceReset.current();
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
        setHasOlderMessages(data.hasMoreMessages ?? false);
        setOlderCursor(data.nextBeforeMessageId ?? null);
        setActiveChat(data.chat);
        setSelectedModel(data.chat.model || defaultModel.current);
        setImageOptions(imageOptionsFromMessages(data.messages));
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
    voiceReset.current();
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
    let pages = 0;
    while (detail.hasMoreMessages && detail.nextBeforeMessageId) {
      if (++pages > 250) throw new Error("对话过长，暂时无法完整导出。");
      const older = await request<FamilyChatDetail>(
        `/api/family/chats/${encodeURIComponent(
          id,
        )}?before=${encodeURIComponent(detail.nextBeforeMessageId)}`,
      );
      detail.messages = [...older.messages, ...detail.messages];
      detail.hasMoreMessages = older.hasMoreMessages;
      detail.nextBeforeMessageId = older.nextBeforeMessageId;
    }
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
    contentOverride?: string,
    voiceOrigin = false,
  ) => {
    const content = (contentOverride ?? draft).trim();
    const hasDraftFiles = mode === "send" && draftAttachments.hasAny();
    if (
      (mode === "send" && !content && !hasDraftFiles) ||
      (mode === "edit" && !content) ||
      draftAttachments.preparing ||
      (mode === "send" && draftAttachments.hasErrors) ||
      sending ||
      realtimeBusy.current ||
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
    const generationModel = models.find((model) => model.id === selectedModel);
    if (!generationModel) {
      setError("请先选择一个可用模型。");
      return;
    }
    const capabilityError =
      mode === "send"
        ? generationModel.kind === "image" && hasDraftFiles
          ? "图片生成暂不支持附件，请先移除附件。"
          : attachmentModelError(draftAttachments.items, generationModel)
        : "";
    if (capabilityError) {
      setError(capabilityError);
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
    let completedReply: FamilyMessage | null = null;
    try {
      const attachments =
        mode === "send"
          ? await encodeAttachmentInputs(
              draftAttachments.snapshot(),
              controller.signal,
            )
          : [];
      if (generation !== epoch.current) throw new StaleRequest();
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
      const optimisticAssistantId = `local-assistant-${requestId}`;
      assistantId = optimisticAssistantId;
      const createdAt = new Date().toISOString();
      if (mode === "send")
        setMessages((previous) => [
          ...previous,
          {
            id: userId,
            role: "user",
            content: content || "附件消息",
            status: "complete",
            createdAt,
          },
          {
            id: optimisticAssistantId,
            role: "assistant",
            content: "",
            status: "streaming",
            createdAt,
            requestedModel: selectedModel,
            ...(generationModel.kind === "image" ? { imageOptions } : {}),
          },
        ]);
      if (mode === "send" || mode === "edit") setDraft("");
      const payload: FamilyMessageRequest =
        mode === "send"
          ? {
              content,
              requestId,
              model: selectedModel,
              ...(attachments.length ? { attachments } : {}),
            }
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
      if (generationModel.kind === "image")
        payload.imageOptions = { ...imageOptions };
      const serialized = JSON.stringify(payload);
      if (new Blob([serialized]).size >= ATTACHMENT_LIMITS.wireBytes)
        throw new Error("消息与附件合计过大，请移除部分附件后重试。");
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
          body: serialized,
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
          if (mode === "send") draftAttachments.clear();
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
            streamEvent.userMessage.id,
            streamEvent.assistantMessage.id,
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
          completedReply = { ...streamEvent.message, usage: streamEvent.usage };
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
      if (rejectedBeforeStream || !accepted) {
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
            setHasOlderMessages(detail.hasMoreMessages ?? false);
            setOlderCursor(detail.nextBeforeMessageId ?? null);
            acceptChat(detail.chat);
            setSelectedModel(detail.chat.model || defaultModel.current);
            setImageOptions(imageOptionsFromMessages(detail.messages));
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
      if (
        generation === epoch.current &&
        identityVerified.current &&
        voiceOrigin &&
        !cancelPendingRef.current &&
        !active?.cancelAcknowledged &&
        !active?.alreadyComplete &&
        autoReadVoiceRef.current &&
        done &&
        completedReply &&
        chatId
      )
        void voice.speak(chatId, completedReply);
    }
  };
  voiceSubmit.current = async (text, scope) => {
    if (
      scope.epoch !== epoch.current ||
      scope.userId !== currentUser.current?.id ||
      scope.chatId !== selectedChatRef.current ||
      scope.model !== selectedModel ||
      models.some(
        (model) => model.id === selectedModel && model.kind === "image",
      ) ||
      !identityVerified.current ||
      draft.trim() ||
      draftAttachments.hasAny()
    )
      return;
    await generateMessage("send", undefined, text, true);
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
          setHasOlderMessages(detail.hasMoreMessages ?? false);
          setOlderCursor(detail.nextBeforeMessageId ?? null);
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
    voiceReset.current();
    const data = await request<{
      users: FamilyAdminUser[];
    }>("/api/family/admin/users");
    setAdminUsers(data.users);
    setArchiveConfirm(false);
    setScreen("admin");
    setSidebarOpen(false);
  };
  realtimeFinished.current = (chatId) => {
    const generation = epoch.current;
    const version = ++realtimeSyncVersion.current;
    if (realtimeSyncTimer.current !== null)
      window.clearTimeout(realtimeSyncTimer.current);
    realtimeSyncTimer.current = null;
    void loadChats().catch((failure) => {
      if (generation === epoch.current && !(failure instanceof StaleRequest))
        setNotice("通话已结束，请稍后刷新聊天列表。");
    });
    const mayOpenNew =
      selectedChatRef.current === null &&
      !draft.trim() &&
      !draftAttachments.hasAny();
    if (selectedChatRef.current !== chatId && !mayOpenNew) return;
    const synchronize = (attempt: number) => {
      void request<FamilyChatDetail>(
        `/api/family/chats/${encodeURIComponent(chatId)}`,
        {},
        4000,
      )
        .then((detail) => {
          if (
            generation !== epoch.current ||
            streamController.current ||
            realtimeBusy.current ||
            version !== realtimeSyncVersion.current
          )
            return;
          if (
            detail.messages.some((message) => message.status === "streaming") &&
            attempt < 3
          ) {
            realtimeSyncTimer.current = window.setTimeout(
              () => {
                realtimeSyncTimer.current = null;
                synchronize(attempt + 1);
              },
              500 * (attempt + 1),
            );
            return;
          }
          if (
            selectedChatRef.current !== chatId &&
            !(
              mayOpenNew &&
              selectedChatRef.current === null &&
              !composerInput.current?.value &&
              !draftAttachments.hasAny()
            )
          )
            return;
          selectedChatRef.current = chatId;
          setSelectedChat(chatId);
          setActiveChat(detail.chat);
          setMessages(detail.messages);
          setHasOlderMessages(detail.hasMoreMessages ?? false);
          setOlderCursor(detail.nextBeforeMessageId ?? null);
          setSelectedModel(detail.chat.model || defaultModel.current);
          setImageOptions(imageOptionsFromMessages(detail.messages));
        })
        .catch((failure) => {
          if (
            generation === epoch.current &&
            version === realtimeSyncVersion.current &&
            !(failure instanceof StaleRequest)
          )
            setNotice("通话已结束，记录暂时无法同步，请稍后刷新确认。");
        });
    };
    synchronize(0);
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

  const workspaceRequest = async <T,>(
    path: string,
    init: RequestInit = {},
    timeoutMs = 15000,
  ): Promise<T> => {
    if (!identityVerified.current) throw new Error("请等待登录状态确认。");
    try {
      return await request<T>(path, init, timeoutMs);
    } catch (failure) {
      if (
        failure instanceof RequestError &&
        [401, 403].includes(failure.status)
      ) {
        identityVerified.current = false;
        setIdentityBlocked(true);
        void checkIdentity();
      }
      throw failure;
    }
  };
  const newChat = () => {
    if (
      sending ||
      working ||
      voice.busy ||
      realtimeBusy.current ||
      draftAttachments.preparing ||
      !identityVerified.current
    )
      return;
    if (selectedChatRef.current === null) {
      setScreen("chat");
      setWorkspaceMode("chat");
      setSidebarOpen(false);
      return;
    }
    if (
      (draft.trim() || draftAttachments.hasAny() || editingMessage) &&
      !window.confirm("当前有未发送的内容。放弃草稿和附件，新建聊天？")
    )
      return;
    ++listVersion.current;
    setScreen("chat");
    setWorkspaceMode("chat");
    setSelectedChat(null);
    selectedChatRef.current = null;
    voiceReset.current();
    attachmentReset.current();
    setActiveChat(null);
    setSelectedModel(defaultModel.current);
    setImageOptions({ ...DEFAULT_IMAGE_OPTIONS });
    setRenameTitle(null);
    setEditingMessage(null);
    setDraftBeforeEdit("");
    setArchiveConfirm(false);
    setMessages([]);
    setDraft("");
    setHasOlderMessages(false);
    setOlderCursor(null);
    setSidebarOpen(false);
    setError("");
    followMessages.current = true;
    setFollowLatest(true);
  };
  const loadOlder = async () => {
    const id = selectedChatRef.current;
    if (!id || !olderCursor || olderLoading || !identityVerified.current)
      return;
    const version = listVersion.current;
    const generation = epoch.current;
    const host = messagesHost.current;
    const oldHeight = host?.scrollHeight ?? 0;
    const oldTop = host?.scrollTop ?? 0;
    setOlderLoading(true);
    try {
      const data = await request<FamilyChatDetail>(
        `/api/family/chats/${encodeURIComponent(
          id,
        )}?before=${encodeURIComponent(olderCursor)}`,
      );
      if (version !== listVersion.current || id !== selectedChatRef.current)
        return;
      followMessages.current = false;
      setFollowLatest(false);
      setMessages((previous) => [
        ...data.messages.filter(
          (message) => !previous.some((old) => old.id === message.id),
        ),
        ...previous,
      ]);
      setHasOlderMessages(data.hasMoreMessages ?? false);
      setOlderCursor(data.nextBeforeMessageId ?? null);
      // Layout is read after React commits the prepended page; no jump to bottom.
      window.requestAnimationFrame(() => {
        if (
          generation === epoch.current &&
          version === listVersion.current &&
          host === messagesHost.current &&
          host
        )
          host.scrollTop = oldTop + host.scrollHeight - oldHeight;
      });
    } finally {
      if (generation === epoch.current && version === listVersion.current)
        setOlderLoading(false);
    }
  };
  const loadFiles = useCallback(
    async (query: string, cursor?: string) => {
      if (!identityVerified.current) return;
      const version = ++filesVersion.current;
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (cursor) params.set("cursor", cursor);
      setFileLoading(true);
      try {
        const page = await request<FamilyFilePage>(
          `/api/family/files${params.toString() ? `?${params}` : ""}`,
        );
        if (version !== filesVersion.current || !identityVerified.current)
          return;
        setFiles((previous) =>
          cursor
            ? [
                ...previous,
                ...page.files.filter(
                  (file) => !previous.some((old) => old.id === file.id),
                ),
              ]
            : page.files,
        );
        setFileCursor(page.nextCursor ?? null);
      } finally {
        if (version === filesVersion.current) setFileLoading(false);
      }
    },
    [request],
  );
  useEffect(() => {
    if (
      workspaceMode !== "files" ||
      !user ||
      user.status !== "approved" ||
      checking ||
      !identityVerified.current
    )
      return;
    filesVersion.current++;
    const timer = window.setTimeout(
      () => {
        void loadFiles(fileSearch).catch((failure) => {
          if (!(failure instanceof StaleRequest)) {
            setError(errorText(failure));
            if (
              failure instanceof RequestError &&
              [401, 403].includes(failure.status)
            )
              void checkIdentity();
          }
        });
      },
      fileSearch.trim() ? 250 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      filesVersion.current++;
    };
  }, [workspaceMode, fileSearch, user?.id, checking, loadFiles, checkIdentity]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        composing.current ||
        event.keyCode === 229 ||
        !currentUser.current
      )
        return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSidebarCollapsed(false);
        setSidebarOpen(true);
        window.requestAnimationFrame(() => {
          if (currentUser.current && !settingsOpen)
            searchInput.current?.focus();
        });
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "o"
      ) {
        event.preventDefault();
        newChat();
      } else if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      } else if (event.key === "Escape") {
        setSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  const siteNotice = status?.notice || FAMILY_NOTICE;
  const inputDisabled = working || logoutFailed || checking;
  const approved = user?.status === "approved";
  const visibleChats = [...chats].sort(
    (a, b) => Number(!!b.pinnedAt) - Number(!!a.pinnedAt),
  );
  const chosenModel = models.find((model) => model.id === selectedModel);
  const imageMode = chosenModel?.kind === "image";
  const attachmentError =
    imageMode && draftAttachments.hasAny()
      ? "图片生成暂不支持附件，请先移除附件。"
      : attachmentModelError(draftAttachments.items, chosenModel);
  const attachmentReadScope = (
    chatId: string | null,
    admin = false,
  ): AttachmentScope => ({
    readable: identityVerified.current,
    key: `${attachmentEpoch}:${attachmentOwner}:${
      admin ? "admin" : "owner"
    }:${chatId}`,
    isCurrent: () =>
      attachmentEpoch === epoch.current &&
      attachmentOwner === currentUser.current?.id &&
      identityVerified.current &&
      (admin
        ? currentUser.current?.role === "admin"
        : selectedChatRef.current === chatId),
  });
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
    voice.busy ||
    realtimeBusy.current ||
    draftAttachments.preparing ||
    detailLoading ||
    lastAssistantMessage?.status === "streaming";

  // Only initial/hard checks replace the page. Routine focus checks must keep
  // the file input, IME composition and editor DOM alive.
  if (screen === "loading" || (identityBlocked && approved))
    return (
      <main
        className={styles.shell}
        style={appearance.style}
        data-family-theme={appearance.theme.id}
      >
        <div className={styles.loading} role="status">
          {checking || screen === "loading" ? (
            screen === "loading" ? (
              "正在确认登录状态…"
            ) : (
              "正在重新确认登录状态…"
            )
          ) : (
            <>
              <p>{identityWarning}</p>
              <button onClick={() => void checkIdentity()}>
                重新检查登录状态
              </button>
            </>
          )}
        </div>
      </main>
    );

  if (!approved || !["chat", "admin"].includes(screen)) {
    const setup = screen === "setup";
    const register = screen === "register";
    const pending = screen === "pending";
    return (
      <main
        className={styles.shell}
        style={appearance.style}
        data-family-theme={appearance.theme.id}
      >
        <div className={styles.authCard}>
          <div className={styles.authTop}>
            <div className={styles.eyebrow}>FAMILY CHAT</div>
            <ThemeSettings
              theme={appearance.theme}
              onChange={appearance.setTheme}
            />
          </div>
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
      <main
        className={styles.shell}
        style={appearance.style}
        data-family-theme={appearance.theme.id}
      >
        <section className={styles.authCard}>
          <div className={styles.authTop}>
            <div className={styles.eyebrow}>FAMILY CHAT</div>
            <ThemeSettings
              theme={appearance.theme}
              onChange={appearance.setTheme}
            />
          </div>
          <h1>{user.role === "admin" ? "更新聊天功能" : "服务正在升级"}</h1>
          <p className={styles.subtitle}>
            {user.role === "admin"
              ? "更新后即可使用实时语音聊天。"
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
    <main
      className={styles.shell}
      style={appearance.style}
      data-family-theme={appearance.theme.id}
      data-family-font={preferences.font}
      data-family-density={preferences.density}
    >
      <div className={styles.app}>
        <aside
          className={`${styles.sidebar} ${
            sidebarCollapsed ? styles.sidebarCollapsed : ""
          } ${sidebarOpen ? styles.sidebarOpen : ""}`}
        >
          <div className={styles.sidebarBrand}>
            <strong className={styles.navLabel}>Family Chat</strong>
            <button
              className={styles.iconButton}
              aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
              title="收起 / 展开侧栏"
              onClick={() => {
                setSidebarCollapsed((value) => !value);
                setSidebarOpen(false);
              }}
            >
              <FamilyIcon name="panel" />
            </button>
          </div>
          <div className={styles.sidebarTop}>
            <button
              className={styles.navButton}
              disabled={
                sending ||
                working ||
                voice.busy ||
                realtimeBusy.current ||
                draftAttachments.preparing
              }
              onClick={newChat}
              aria-label="＋ 新聊天"
              title="新聊天 · Ctrl/⌘ Shift O"
            >
              <FamilyIcon name="plus" />
              <span className={styles.navLabel}>新聊天</span>
              <small className={styles.navShortcut}>⌘ ⇧ O</small>
            </button>
            <button
              className={styles.navButton}
              disabled={voice.busy || realtimeBusy.current}
              onClick={() => {
                setSidebarCollapsed(false);
                searchInput.current?.focus();
              }}
              title="搜索聊天 · Ctrl/⌘ K"
            >
              <FamilyIcon name="search" />
              <span className={styles.navLabel}>搜索聊天</span>
              <small className={styles.navShortcut}>⌘ K</small>
            </button>
            <button
              className={`${styles.navButton} ${
                workspaceMode === "files" ? styles.activeChat : ""
              }`}
              disabled={
                voice.busy || realtimeBusy.current || sending || working
              }
              onClick={() => {
                setWorkspaceMode("files");
                setScreen("chat");
                setSidebarOpen(false);
              }}
              title="我的文件"
            >
              <FamilyIcon name="file" />
              <span className={styles.navLabel}>我的文件</span>
            </button>
            <button
              className={`${styles.navButton} ${
                workspaceMode === "usage" ? styles.activeChat : ""
              }`}
              disabled={
                voice.busy || realtimeBusy.current || sending || working
              }
              onClick={() => {
                setWorkspaceMode("usage");
                setScreen("chat");
                setSidebarOpen(false);
              }}
              title="我的用量"
            >
              <FamilyIcon name="chart" />
              <span className={styles.navLabel}>我的用量</span>
            </button>
          </div>
          <label className={styles.searchField}>
            <span className={styles.srOnly}>搜索聊天</span>
            <input
              ref={searchInput}
              type="search"
              value={search}
              disabled={voice.busy || realtimeBusy.current}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索标题和聊天内容"
            />
          </label>
          <div className={styles.listHeading}>
            <span className={styles.navLabel}>
              {search ? "搜索结果" : archivedView ? "已归档" : "最近聊天"}
            </span>
            <button
              className={styles.iconButton}
              title={archivedView ? "查看最近聊天" : "查看归档"}
              aria-label={archivedView ? "查看最近聊天" : "查看归档"}
              disabled={listLoading || voice.busy || realtimeBusy.current}
              onClick={() => setArchivedView((value) => !value)}
            >
              <FamilyIcon
                name={archivedView ? "message" : "archive"}
                size={16}
              />
            </button>
          </div>
          <nav
            className={styles.chatList}
            aria-label="我的聊天"
            aria-busy={listLoading}
          >
            {!visibleChats.length ? (
              <div className={styles.muted}>
                <p>
                  {listLoading
                    ? "正在搜索…"
                    : search
                    ? "没有匹配的聊天。"
                    : archivedView
                    ? "暂无归档聊天。"
                    : "聊天会保存到你的账户。"}
                </p>
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
              visibleChats.map((chat, index) => (
                <div className={styles.chatRow} key={chat.id}>
                  {chat.pinnedAt && !visibleChats[index - 1]?.pinnedAt ? (
                    <small className={styles.listHeading}>已置顶</small>
                  ) : !chat.pinnedAt && visibleChats[index - 1]?.pinnedAt ? (
                    <small className={styles.listHeading}>其他聊天</small>
                  ) : null}
                  <button
                    className={`${styles.chatRowMain} ${
                      selectedChat === chat.id &&
                      screen === "chat" &&
                      workspaceMode === "chat"
                        ? styles.activeChat
                        : ""
                    }`}
                    disabled={
                      sending ||
                      working ||
                      voice.busy ||
                      realtimeBusy.current ||
                      draftAttachments.preparing
                    }
                    title={chat.title || "新聊天"}
                    onClick={() => {
                      if (chat.archived) {
                        void run(async () => {
                          await request(
                            `/api/family/chats/${encodeURIComponent(chat.id)}`,
                            {
                              method: "PATCH",
                              body: JSON.stringify({ archived: false }),
                            },
                          );
                          await loadChats();
                          setNotice("聊天已恢复，可在最近聊天中打开。");
                        });
                      } else {
                        setScreen("chat");
                        void run(() => selectChat(chat.id));
                      }
                    }}
                  >
                    <span>
                      {chat.pinnedAt ? "⌁ " : ""}
                      {chat.title || "新聊天"}
                    </span>
                    {chat.matchSnippet ? (
                      <small className={styles.chatSnippet}>
                        {chat.matchSnippet}
                      </small>
                    ) : (
                      <small>
                        {chat.archived ? "点击恢复 · " : ""}
                        {new Date(chat.updatedAt).toLocaleDateString("zh-CN")}
                      </small>
                    )}
                  </button>
                </div>
              ))
            )}
            {nextChatCursor ? (
              <button
                disabled={listLoading || checking}
                className={styles.textButton}
                onClick={() => void run(() => loadChats(nextChatCursor))}
              >
                {listLoading ? "正在加载…" : "加载更多聊天"}
              </button>
            ) : null}
          </nav>
          <div className={styles.account}>
            <button
              className={styles.settingsLauncher}
              aria-label="打开设置"
              title="设置 · Ctrl/⌘ ,"
              onClick={() => setSettingsOpen(true)}
            >
              <span className={styles.userBadge}>
                {user.name.slice(0, 1).toUpperCase()}
              </span>
              <span className={styles.navLabel}>
                <strong>{user.name}</strong>
                <small>设置与账户</small>
              </span>
              <FamilyIcon name="settings" />
            </button>
            {user.role === "admin" ? (
              <button
                className={`${styles.secondary} ${styles.navLabel}`}
                disabled={
                  sending ||
                  working ||
                  voice.busy ||
                  realtimeBusy.current ||
                  draftAttachments.preparing
                }
                onClick={() => void run(openAdmin)}
              >
                账户与用量管理
              </button>
            ) : null}
            <button
              className={`${styles.textButton} ${styles.navLabel}`}
              onClick={() => void logout()}
            >
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
              disabled={voice.busy || realtimeBusy.current}
              onClick={() => setSidebarOpen(true)}
            >
              会话
            </button>
            <div className={styles.headerTitle}>
              <h1>
                {screen === "admin"
                  ? "账户与用量管理"
                  : workspaceMode === "files"
                  ? "我的文件"
                  : workspaceMode === "usage"
                  ? "我的用量"
                  : activeChat?.title ||
                    chats.find((chat) => chat.id === selectedChat)?.title ||
                    "新聊天"}
              </h1>
            </div>
            {screen === "chat" && workspaceMode === "chat" && !realtime.busy ? (
              <details className={styles.conversationMenu}>
                <summary aria-label="对话操作" title="对话操作">
                  <FamilyIcon name="dots" />
                </summary>
                <div className={`${styles.chatTools} ${styles.menuPanel}`}>
                  <button
                    className={styles.secondary}
                    disabled={turnLocked || !activeChat}
                    onClick={() =>
                      void run(async () => {
                        const response = await request<{ chat: FamilyChat }>(
                          `/api/family/chats/${encodeURIComponent(
                            activeChat!.id,
                          )}`,
                          {
                            method: "PATCH",
                            body: JSON.stringify({
                              pinned: !activeChat!.pinnedAt,
                            }),
                          },
                        );
                        acceptChat(response.chat);
                        await loadChats();
                      })
                    }
                  >
                    {activeChat?.pinnedAt ? "取消置顶" : "置顶对话"}
                  </button>
                  <button
                    className={styles.secondary}
                    disabled={turnLocked || !activeChat}
                    onClick={() =>
                      setRenameTitle(
                        chats.find((chat) => chat.id === selectedChat)?.title ??
                          activeChat?.title ??
                          "",
                      )
                    }
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
                    disabled={
                      sending ||
                      working ||
                      cancelPending ||
                      voice.busy ||
                      realtimeBusy.current
                    }
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
                          setHasOlderMessages(detail.hasMoreMessages ?? false);
                          setOlderCursor(detail.nextBeforeMessageId ?? null);
                          acceptChat(detail.chat);
                          setSelectedModel(
                            detail.chat.model || defaultModel.current,
                          );
                          setImageOptions(
                            imageOptionsFromMessages(detail.messages),
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
              </details>
            ) : null}
            <button
              className={styles.iconButton}
              aria-label="设置"
              title="设置"
              onClick={() => setSettingsOpen(true)}
            >
              <FamilyIcon name="settings" />
            </button>
            {user.role === "admin" && screen !== "admin" ? (
              <button
                disabled={
                  sending || working || voice.busy || realtimeBusy.current
                }
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
            <RealtimePanel controller={realtime} embedded />
          ) : null}
          <FamilySettings
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            user={user}
            expiresAt={expiresAt}
            theme={appearance.theme}
            onThemeChange={appearance.setTheme}
            preferences={preferences}
            onPreferencesChange={setPreferences}
            voice={realtime.voice}
            onVoiceChange={realtime.setVoice}
            vad={realtime.vad}
            onVadChange={realtime.setVad}
            voiceBusy={realtime.busy || voice.busy}
            autoReadVoice={autoReadVoice}
            onAutoReadVoiceChange={setAutoReadVoice}
            tapRecord={tapRecord}
            onTapRecordChange={setTapRecord}
            locked={checking || working || !identityVerified.current}
            onSaveProfile={async (name) => {
              if (!identityVerified.current)
                throw new Error("请等待登录状态确认。");
              const me = await workspaceRequest<FamilyMe>("/api/family/me", {
                method: "PATCH",
                body: JSON.stringify({ name }),
              });
              const previous = currentUser.current;
              if (
                !previous ||
                me.user.id !== previous.id ||
                me.user.role !== previous.role ||
                me.user.status !== "approved"
              ) {
                clearPrivate();
                setScreen("loading");
                void checkIdentity();
                throw new StaleRequest();
              }
              currentUser.current = me.user;
              setUser(me.user);
              setExpiresAt(me.sessionExpiresAt);
              return me;
            }}
            onLoadSessions={() =>
              workspaceRequest<{ sessions: FamilySessionSummary[] }>(
                "/api/family/me/sessions",
              )
            }
            onRevokeSession={async (id) => {
              if (!identityVerified.current) throw new StaleRequest();
              await workspaceRequest(
                `/api/family/me/sessions/${encodeURIComponent(id)}`,
                { method: "DELETE" },
              );
            }}
            onRevokeOthers={async () => {
              if (!identityVerified.current) throw new StaleRequest();
              await workspaceRequest("/api/family/me/sessions/revoke-others", {
                method: "POST",
                body: "{}",
              });
            }}
            onLogout={() => void logout()}
          />
          {screen === "chat" && workspaceMode === "usage" ? (
            <UsageDashboard
              admin={false}
              locked={checking || working || !identityVerified.current}
              scopeKey={`${attachmentEpoch}:${attachmentOwner}:self-usage`}
              isCurrent={() =>
                attachmentEpoch === epoch.current &&
                attachmentOwner === currentUser.current?.id &&
                identityVerified.current
              }
              onLoad={(days) =>
                workspaceRequest<UsageDashboardData>(
                  `/api/family/usage?days=${encodeURIComponent(String(days))}`,
                )
              }
            />
          ) : null}
          {screen === "chat" && workspaceMode === "files" ? (
            <section className={styles.filePanel} aria-label="我的文件库">
              <h2>我的文件</h2>
              <p className={styles.muted}>
                整理你在聊天中发送的文件，点击可预览或下载。
              </p>
              <label className={styles.fileSearch}>
                <span className={styles.srOnly}>搜索文件</span>
                <input
                  type="search"
                  value={fileSearch}
                  placeholder="搜索文件名"
                  onChange={(event) => setFileSearch(event.target.value)}
                />
              </label>
              {fileLoading && !files.length ? (
                <p role="status">正在加载文件…</p>
              ) : !files.length ? (
                <p className={styles.muted}>
                  {fileSearch
                    ? "没有匹配的文件。"
                    : "发送过的附件会显示在这里。"}
                </p>
              ) : (
                files.map((file) => (
                  <article key={file.id} className={styles.fileRow}>
                    <div className={styles.fileMeta}>
                      <FamilyIcon name="file" />
                      <strong>{file.name}</strong>
                      <small>
                        {attachmentSize(file.byteSize)} ·{" "}
                        {new Date(file.createdAt).toLocaleDateString("zh-CN")}
                      </small>
                    </div>
                    <button
                      className={styles.textButton}
                      disabled={turnLocked || checking}
                      onClick={() =>
                        void run(async () => {
                          if (file.chatArchived) {
                            await request(
                              `/api/family/chats/${encodeURIComponent(
                                file.chatId,
                              )}`,
                              {
                                method: "PATCH",
                                body: JSON.stringify({ archived: false }),
                              },
                            );
                            await loadFiles(fileSearch);
                            await loadChats();
                          }
                          await selectChat(file.chatId);
                        })
                      }
                    >
                      {file.chatArchived ? "恢复并打开聊天" : "打开聊天"} ·{" "}
                      {file.chatTitle || "新聊天"}
                    </button>
                    {!file.chatArchived ? (
                      <MessageAttachments
                        attachments={[file]}
                        scope={{
                          readable: identityVerified.current,
                          key: `${attachmentEpoch}:${attachmentOwner}:files:${file.id}`,
                          isCurrent: () =>
                            attachmentEpoch === epoch.current &&
                            attachmentOwner === currentUser.current?.id &&
                            identityVerified.current,
                        }}
                        onUnauthorized={() => void checkIdentity()}
                      />
                    ) : (
                      <small className={styles.muted}>恢复聊天后可下载。</small>
                    )}
                  </article>
                ))
              )}
              {fileCursor ? (
                <button
                  disabled={fileLoading || checking}
                  onClick={() =>
                    void run(() => loadFiles(fileSearch, fileCursor))
                  }
                >
                  {fileLoading ? "正在加载…" : "加载更多文件"}
                </button>
              ) : null}
            </section>
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
          {identityWarning ? (
            <div className={styles.bannerError} role="status">
              {identityWarning}{" "}
              <button
                disabled={checking}
                onClick={() =>
                  void checkIdentity({ background: true, force: true })
                }
              >
                重新检查登录状态
              </button>
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
              <p>
                归档后从你的列表隐藏，可在归档中恢复。
                {draft.trim() || draftAttachments.hasAny()
                  ? "归档也会放弃未发送的草稿和附件。"
                  : ""}
              </p>
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
                      voiceReset.current();
                      attachmentReset.current();
                      selectedChatRef.current = null;
                      setActiveChat(null);
                      setEditingMessage(null);
                      setDraftBeforeEdit("");
                      setMessages([]);
                      setDraft("");
                      setArchiveConfirm(false);
                      await loadChats();
                      setNotice("对话已归档。");
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
              {user.role === "admin" ? (
                <UsageDashboard
                  admin
                  locked={checking || working || !identityVerified.current}
                  scopeKey={`${attachmentEpoch}:${attachmentOwner}:admin-usage`}
                  isCurrent={() =>
                    attachmentEpoch === epoch.current &&
                    attachmentOwner === currentUser.current?.id &&
                    currentUser.current?.role === "admin" &&
                    identityVerified.current
                  }
                  onLoad={(days, userId) => {
                    const params = new URLSearchParams({ days: String(days) });
                    if (userId) params.set("userId", userId);
                    return workspaceRequest<UsageDashboardData>(
                      `/api/family/admin/usage?${params}`,
                    );
                  }}
                />
              ) : null}
              {user.role === "admin" ? (
                <ProviderAdminPanel
                  scopeKey={`${attachmentEpoch}:${attachmentOwner}:admin`}
                  locked={checking || working || !identityVerified.current}
                  isCurrent={() =>
                    attachmentEpoch === epoch.current &&
                    attachmentOwner === currentUser.current?.id &&
                    currentUser.current?.role === "admin" &&
                    identityVerified.current
                  }
                  onLoad={() =>
                    workspaceRequest<ProviderAdminSnapshot>(
                      "/api/family/admin/providers/refresh",
                      {
                        method: "POST",
                        body: JSON.stringify({ force: false }),
                      },
                      30000,
                    )
                  }
                  onRefresh={() =>
                    workspaceRequest<ProviderAdminSnapshot>(
                      "/api/family/admin/providers/refresh",
                      { method: "POST", body: JSON.stringify({ force: true }) },
                      30000,
                    )
                  }
                  onSave={(input) =>
                    workspaceRequest<ProviderAdminSnapshot>(
                      "/api/family/admin/providers",
                      { method: "PATCH", body: JSON.stringify(input) },
                    )
                  }
                />
              ) : null}
              <section className={styles.inviteGuide}>
                <h2>邀请家人</h2>
                <p>
                  点击“生成单次邀请”，再把链接发给一位家人。每个邀请仅限一人注册，注册后你还需要在下方批准加入。
                </p>
              </section>
              <div className={styles.adminToolbar}>
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
                      <dt>活跃时长（估算）</dt>
                      <dd>{durationText(account.activeSeconds)}</dd>
                      <dt>已报告输入 / 输出 token</dt>
                      <dd>
                        {account.inputTokens.toLocaleString()} /{" "}
                        {account.outputTokens.toLocaleString()}
                      </dd>
                      <dt>用量未知的请求</dt>
                      <dd>{account.unknownUsageRequests}</dd>
                      <dt>语音请求 / 用量未知</dt>
                      <dd>
                        {account.voiceRequests ?? "未报告"} /{" "}
                        {account.voiceUnknownUsageRequests ?? "未报告"}
                      </dd>
                      <dt>语音已报告输入 / 输出 token</dt>
                      <dd>
                        {account.voiceInputTokens?.toLocaleString() ?? "未报告"}{" "}
                        /{" "}
                        {account.voiceOutputTokens?.toLocaleString() ??
                          "未报告"}
                      </dd>
                      <dt>录音与播报时长（非计费）</dt>
                      <dd>
                        {account.voiceAudioSeconds === undefined
                          ? "未报告"
                          : `${account.voiceAudioSeconds.toFixed(1)} 秒`}
                      </dd>
                      {account.realtimeRequests !== undefined ? (
                        <>
                          <dt>实时语音输入 / 输出 token</dt>
                          <dd>
                            {account.realtimeInputTokens?.toLocaleString() ??
                              "未报告"}{" "}
                            /{" "}
                            {account.realtimeOutputTokens?.toLocaleString() ??
                              "未报告"}
                          </dd>
                          <dt>实时语音用量未知的请求</dt>
                          <dd>
                            {account.realtimeUnknownUsageRequests ?? "未报告"}
                          </dd>
                          <dt>已统计的实时录音时长（非计费）</dt>
                          <dd>
                            {account.realtimeAudioSeconds === undefined
                              ? "未报告"
                              : `${account.realtimeAudioSeconds.toFixed(1)} 秒`}
                          </dd>
                        </>
                      ) : null}
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
                      {adminDetail.hasMoreMessages &&
                      adminDetail.nextBeforeMessageId ? (
                        <button
                          disabled={working || checking}
                          className={styles.historyLoad}
                          onClick={() =>
                            void run(async () => {
                              const version = adminVersion.current;
                              const id = adminDetail.chat.id;
                              const data = await request<FamilyChatDetail>(
                                `/api/family/admin/chats/${encodeURIComponent(
                                  id,
                                )}?before=${encodeURIComponent(
                                  adminDetail.nextBeforeMessageId!,
                                )}`,
                              );
                              if (version === adminVersion.current)
                                setAdminDetail((previous) =>
                                  previous?.chat.id === id
                                    ? {
                                        ...data,
                                        messages: [
                                          ...data.messages,
                                          ...previous.messages,
                                        ],
                                      }
                                    : previous,
                                );
                            })
                          }
                        >
                          加载更早消息
                        </button>
                      ) : null}
                      {adminDetail.messages.length ? (
                        adminDetail.messages.map((message) => (
                          <MessageBody
                            key={message.id}
                            message={message}
                            userLabel={adminSelectedUser.name}
                            attachmentScope={attachmentReadScope(
                              adminDetail.chat.id,
                              true,
                            )}
                            attachmentAdmin
                            onAttachmentUnauthorized={() =>
                              void checkIdentity()
                            }
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
                ref={messagesHost}
                className={styles.messages}
                onScroll={(event) => {
                  const host = event.currentTarget;
                  const follow =
                    host.scrollHeight - host.scrollTop - host.clientHeight <
                    120;
                  followMessages.current = follow;
                  setFollowLatest(follow);
                }}
                style={
                  realtime.busy || workspaceMode !== "chat"
                    ? { display: "none" }
                    : undefined
                }
                aria-label="聊天记录"
                aria-busy={sending}
              >
                {hasOlderMessages ? (
                  <button
                    className={styles.historyLoad}
                    disabled={
                      olderLoading || detailLoading || checking || sending
                    }
                    onClick={() => void run(loadOlder)}
                  >
                    {olderLoading ? "正在加载…" : "加载更早消息"}
                  </button>
                ) : null}
                {detailLoading ? (
                  <p className={styles.muted} role="status">
                    正在加载聊天…
                  </p>
                ) : selectedChat && !activeChat ? (
                  <div className={styles.welcome}>
                    <h2>聊天暂时没有加载成功</h2>
                    <p>请点上方“刷新”或重新选择此聊天重试。</p>
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
                          attachmentScope={attachmentReadScope(selectedChat)}
                          onAttachmentUnauthorized={() => void checkIdentity()}
                          onSpeak={(reply) => {
                            if (selectedChat && !realtimeBusy.current)
                              void voice.speak(selectedChat, reply);
                          }}
                          speechDisabled={
                            realtimeBusy.current ||
                            voice.phase !== "idle" ||
                            sending ||
                            cancelPending ||
                            working
                          }
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
                                if (message.imageOptions)
                                  setImageOptions(
                                    imageOptionsFromMessages([message]),
                                  );
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
                  <div className={styles.emptyHero}>
                    <span className={styles.emptyMark}>
                      <FamilyIcon name="message" size={32} />
                    </span>
                    <h2>今天有什么想聊的？</h2>
                    <p>把问题、灵感或一份文件带过来。</p>
                    <div className={styles.suggestions}>
                      {[
                        "帮我梳理一个想法",
                        "解释一个我不懂的概念",
                        "一起安排这周的生活",
                        "润色一段想说的话",
                      ].map((text) => (
                        <button
                          key={text}
                          type="button"
                          className={styles.suggestion}
                          disabled={turnLocked || checking}
                          onClick={() => {
                            setDraft((previous) =>
                              previous.trim() ? `${previous}\n${text}` : text,
                            );
                            composerInput.current?.focus();
                          }}
                        >
                          {text}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div ref={bottom} />
              </div>
              {!followLatest &&
              messages.length &&
              workspaceMode === "chat" &&
              !realtime.busy ? (
                <button
                  className={styles.scrollLatest}
                  onClick={() => {
                    followMessages.current = true;
                    setFollowLatest(true);
                    bottom.current?.scrollIntoView({ block: "end" });
                  }}
                >
                  <FamilyIcon name="arrowDown" size={16} />
                  回到最新消息
                </button>
              ) : null}
              <form
                className={styles.composer}
                style={
                  realtime.busy || workspaceMode !== "chat"
                    ? { display: "none" }
                    : undefined
                }
                onSubmit={(event) => {
                  event.preventDefault();
                  void generateMessage(
                    editingMessage ? "edit" : "send",
                    editingMessage ?? undefined,
                  );
                }}
              >
                {voice.phase !== "idle" ? (
                  <div className={styles.voiceStatus} role="status">
                    <span>
                      {voice.phase === "permission"
                        ? "正在等待麦克风权限；允许后可重新按住说话。"
                        : voice.phase === "recording"
                        ? `${
                            voiceOutside ? "松手取消" : "正在录音，松开发送"
                          } · ${voice.seconds}/45 秒`
                        : voice.phase === "processing"
                        ? "正在处理录音…"
                        : "正在识别语音…"}
                    </span>
                    <button
                      type="button"
                      className={styles.textButton}
                      onClick={() => {
                        voice.cancelRecording();
                        setNotice("已取消语音输入。");
                      }}
                    >
                      取消语音
                    </button>
                  </div>
                ) : null}
                {voice.playback.status !== "idle" ? (
                  <div className={styles.voicePlayback} role="status">
                    <span>
                      {voice.playback.status === "loading"
                        ? "正在生成 AI 语音…"
                        : voice.playback.status === "ready"
                        ? "AI 语音已就绪，点击播放"
                        : voice.playback.status === "paused"
                        ? "AI 语音已暂停"
                        : voice.playback.status === "ended"
                        ? "AI 语音朗读已结束"
                        : "正在播放 AI 生成声音"}
                      {voice.playback.parts > 0
                        ? ` · ${voice.playback.part + 1}/${
                            voice.playback.parts
                          } 段`
                        : ""}
                    </span>
                    <div>
                      {voice.playback.status === "playing" ? (
                        <button
                          type="button"
                          className={styles.textButton}
                          onClick={voice.pause}
                        >
                          暂停
                        </button>
                      ) : ["paused", "ready"].includes(
                          voice.playback.status,
                        ) ? (
                        <button
                          type="button"
                          onClick={() => void voice.resume()}
                        >
                          {voice.playback.status === "ready"
                            ? "点击播放"
                            : "继续播放"}
                        </button>
                      ) : null}
                      {voice.playback.status !== "loading" ? (
                        <button
                          type="button"
                          className={styles.textButton}
                          onClick={voice.replay}
                        >
                          重播已生成语音
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={styles.textButton}
                        onClick={voice.stopPlayback}
                      >
                        停止播放
                      </button>
                    </div>
                    {voice.playback.truncated ? (
                      <small>
                        回复较长，仅朗读前 10 段；完整文字保留在聊天中。
                      </small>
                    ) : null}
                  </div>
                ) : null}
                {editingMessage ? (
                  <div className={styles.editingNotice}>
                    <strong>编辑上一条提问</strong>
                    <span>将重新回复这一轮。</span>
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
                {modelError ? (
                  <div className={styles.composerModelError} role="alert">
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
                {imageMode ? (
                  <ImageGenerationControls
                    options={imageOptions}
                    onChange={setImageOptions}
                    disabled={
                      turnLocked || checking || !identityVerified.current
                    }
                  />
                ) : null}

                <label className={styles.srOnly} htmlFor="family-message">
                  发送消息
                </label>
                <textarea
                  id="family-message"
                  ref={composerInput}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={
                    imageMode
                      ? "描述想生成的画面…"
                      : editingMessage
                      ? "修改上一条提问…"
                      : "输入消息…"
                  }
                  rows={2}
                  maxLength={12000}
                  disabled={
                    sending ||
                    working ||
                    detailLoading ||
                    voice.busy ||
                    realtimeBusy.current
                  }
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
                      (preferences.sendKey === "enter" ||
                        event.ctrlKey ||
                        event.metaKey) &&
                      !event.nativeEvent.isComposing &&
                      !composing.current &&
                      event.keyCode !== 229
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />

                <p id="family-voice-help" className={styles.srOnly}>
                  {draft.trim() || draftAttachments.hasAny()
                    ? "有未发送的文字或附件，请先发送或清空后再录音。"
                    : !voice.supported
                    ? "此浏览器暂不支持录音；仍可使用文字聊天。"
                    : "松开发送，移出取消。最长 45 秒自动结束，仅发送前 45 秒；首次允许麦克风后请重新录音。"}
                </p>
                <div className={styles.composerActions}>
                  <AttachmentComposer
                    compact
                    items={draftAttachments.items}
                    disabled={
                      sending ||
                      cancelPending ||
                      working ||
                      detailLoading ||
                      voice.busy ||
                      realtimeBusy.current
                    }
                    editing={!!editingMessage}
                    error={attachmentError}
                    onFiles={(files) => void draftAttachments.addFiles(files)}
                    onRemove={draftAttachments.remove}
                  />
                  <label className={styles.modelPicker}>
                    <span>模型</span>
                    <select
                      aria-label="选择模型"
                      title={modelDescription(selectedModel) || "选择模型"}
                      value={selectedModel}
                      disabled={
                        sending ||
                        working ||
                        detailLoading ||
                        modelLoading ||
                        voice.busy ||
                        realtimeBusy.current ||
                        draftAttachments.preparing ||
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
                      {[
                        { label: "文字聊天", image: false },
                        { label: "图片生成", image: true },
                      ].map((group) => {
                        const options = models.filter(
                          (model) => (model.kind === "image") === group.image,
                        );
                        return options.length ? (
                          <optgroup key={group.label} label={group.label}>
                            {options.map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.name}
                                {model.reasoning ? " · 推理" : ""}
                                {modelDescription(model.id)
                                  ? ` · ${modelDescription(model.id)}`
                                  : ""}
                              </option>
                            ))}
                          </optgroup>
                        ) : null;
                      })}
                    </select>
                  </label>
                  <div className={styles.voiceTools}>
                    <button
                      type="button"
                      className={`${styles.voiceButton} ${
                        voice.phase === "recording" ? styles.voiceRecording : ""
                      }`}
                      aria-label={
                        tapRecord
                          ? "点击录音，再次点击发送"
                          : "按住说话，松开发送，移出取消"
                      }
                      aria-pressed={voice.phase === "recording"}
                      title={
                        tapRecord
                          ? "点击录音，再次点击发送"
                          : "按住说话，松开发送"
                      }
                      aria-describedby="family-voice-help"
                      disabled={
                        imageMode ||
                        ["processing", "transcribing"].includes(voice.phase) ||
                        (voice.phase === "idle" &&
                          (!voice.supported ||
                            !!draft.trim() ||
                            draftAttachments.hasAny() ||
                            !!editingMessage ||
                            sending ||
                            cancelPending ||
                            working ||
                            checking ||
                            detailLoading ||
                            !chosenModel ||
                            voice.busy ||
                            realtimeBusy.current))
                      }
                      onContextMenu={(event) => event.preventDefault()}
                      onPointerDown={(event) => {
                        if (
                          tapRecord ||
                          (event.pointerType === "mouse" && event.button !== 0)
                        )
                          return;
                        event.preventDefault();
                        setVoiceOutside(false);
                        try {
                          event.currentTarget.setPointerCapture(
                            event.pointerId,
                          );
                        } catch {
                          /* leaving the button cancels without capture */
                        }
                        voice.startRecording();
                      }}
                      onPointerMove={(event) => {
                        if (
                          !tapRecord &&
                          ["recording", "permission"].includes(voice.phase) &&
                          !withinVoiceButton(event)
                        ) {
                          setVoiceOutside(true);
                          voice.cancelRecording();
                          setNotice("已移出按钮，取消语音输入。");
                        }
                      }}
                      onPointerUp={(event) => {
                        if (tapRecord) return;
                        event.preventDefault();
                        if (withinVoiceButton(event)) voice.releaseRecording();
                        else {
                          voice.cancelRecording();
                          setNotice("已取消语音输入。");
                        }
                        try {
                          event.currentTarget.releasePointerCapture(
                            event.pointerId,
                          );
                        } catch {
                          /* already released */
                        }
                      }}
                      onPointerCancel={() => voice.cancelRecording()}
                      onLostPointerCapture={voice.cancelGesture}
                      onPointerLeave={(event) => {
                        if (
                          !tapRecord &&
                          ["recording", "permission"].includes(voice.phase)
                        ) {
                          setVoiceOutside(true);
                          voice.cancelRecording();
                          setNotice("已移出按钮，取消语音输入。");
                        }
                      }}
                      onKeyDown={(event) => {
                        if (tapRecord || ![" ", "Enter"].includes(event.key))
                          return;
                        event.preventDefault();
                        if (!event.repeat) {
                          setVoiceOutside(false);
                          voice.startRecording();
                        }
                      }}
                      onKeyUp={(event) => {
                        if (tapRecord || ![" ", "Enter"].includes(event.key))
                          return;
                        event.preventDefault();
                        voice.releaseRecording();
                      }}
                      onBlur={voice.cancelGesture}
                      onClick={(event) => {
                        event.preventDefault();
                        if (!tapRecord) return;
                        if (voice.phase === "recording")
                          voice.releaseRecording();
                        else if (voice.phase === "permission")
                          voice.cancelRecording();
                        else voice.startRecording();
                      }}
                    >
                      <FamilyIcon name="mic" />
                      <span className={styles.srOnly}>
                        {voice.phase === "recording"
                          ? tapRecord
                            ? "结束并发送"
                            : voiceOutside
                            ? "松手取消"
                            : "松开发送"
                          : voice.phase === "permission"
                          ? "等待麦克风…"
                          : tapRecord
                          ? "点击开始录音"
                          : "按住说话"}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={styles.voiceButton}
                      aria-label="开始连续语音"
                      title={
                        realtime.supported
                          ? "实时语音对话"
                          : "此浏览器暂不支持连续语音"
                      }
                      disabled={
                        imageMode ||
                        !realtime.supported ||
                        voice.busy ||
                        sending ||
                        working ||
                        checking ||
                        detailLoading ||
                        !!editingMessage ||
                        draftAttachments.preparing ||
                        cancelPending ||
                        !identityVerified.current
                      }
                      onClick={() => void realtime.start()}
                    >
                      <FamilyIcon name="voice" />
                      <span className={styles.srOnly}>连续语音</span>
                    </button>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label="语音设置"
                      onClick={() => setSettingsOpen(true)}
                    >
                      <FamilyIcon name="settings" size={16} />
                    </button>
                  </div>
                  <div className={styles.composerTrailing}>
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
                        className={styles.sendButton}
                        aria-label={
                          imageMode
                            ? editingMessage
                              ? "保存并重新生成图片"
                              : "生成图片"
                            : editingMessage
                            ? "保存并重新回复"
                            : "发送 ↑"
                        }
                        title={
                          imageMode
                            ? editingMessage
                              ? "保存并重新生成图片"
                              : "生成图片"
                            : editingMessage
                            ? "保存并重新回复"
                            : "发送消息"
                        }
                        disabled={
                          (!draft.trim() &&
                            (!!editingMessage || !draftAttachments.hasAny())) ||
                          draftAttachments.preparing ||
                          (!editingMessage &&
                            (draftAttachments.hasErrors ||
                              !!attachmentError)) ||
                          checking ||
                          !identityVerified.current ||
                          working ||
                          detailLoading ||
                          cancelPending ||
                          lastAssistantMessage?.status === "streaming" ||
                          (selectedChat !== null && !activeChat) ||
                          !chosenModel ||
                          voice.busy ||
                          realtimeBusy.current
                        }
                      >
                        <FamilyIcon name="arrowUp" size={20} />
                      </button>
                    )}
                  </div>
                </div>
              </form>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
