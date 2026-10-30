/** Public JSON contracts shared by the family UI and server. No secrets here. */
export type FamilyRole = "admin" | "member";
export type FamilyStatus = "pending" | "approved" | "disabled";
export type FamilyMessageStatus =
  | "complete"
  | "partial"
  | "error"
  | "streaming";
export interface FamilyUser {
  id: string;
  name: string;
  email: string;
  role: FamilyRole;
  status: FamilyStatus;
}
export interface FamilySiteStatus {
  deploymentEnvironment?: "preview" | "production" | "development";
  ready: boolean;
  needsSetup: boolean;
  dbConfigured: boolean;
  notice: string;
  schemaReady?: boolean;
  schemaVersion?: number;
  modelConfigured?: boolean;
}
export interface FamilyMe {
  user: FamilyUser;
  sessionExpiresAt: string;
}
export interface FamilyChat {
  id: string;
  title: string;
  model: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface FamilyUsage {
  source: "reported" | "unknown";
  inputTokens: number | null;
  outputTokens: number | null;
}
export interface FamilyMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: FamilyMessageStatus;
  createdAt: string;
  usage?: FamilyUsage;
  requestedModel?: string | null;
  model?: string | null;
  superseded?: boolean;
}
export interface FamilyModel {
  id: string;
  name: string;
  description: string;
  reasoning: boolean;
}
export interface FamilyModelCatalog {
  models: FamilyModel[];
  defaultModel: string;
}
export type FamilyMessageRequest = {
  requestId: string;
  model?: string;
} & (
  | { mode?: "send"; content: string; sourceMessageId?: never }
  | { mode: "edit"; content: string; sourceMessageId: string }
  | { mode: "retry" | "regenerate"; content?: never; sourceMessageId: string }
);
export interface FamilyChatDetail {
  chat: FamilyChat;
  messages: FamilyMessage[];
}
export interface FamilyAdminUser extends FamilyUser {
  createdAt: string;
  lastSeenAt: string | null;
  activeSeconds: number;
  inputTokens: number;
  outputTokens: number;
  unknownUsageRequests: number;
  voiceRequests?: number;
  voiceInputTokens?: number;
  voiceOutputTokens?: number;
  voiceUnknownUsageRequests?: number;
  /** Measured canonical PCM duration; this is not a billable quantity. */
  voiceAudioSeconds?: number;
}
export interface FamilyVoiceTranscription {
  text: string;
  usage: FamilyUsage;
}
export type FamilyStreamEvent =
  | {
      type: "start";
      userMessage: FamilyMessage;
      assistantMessage: FamilyMessage;
      replacedMessageIds?: string[];
    }
  | { type: "delta"; text: string }
  | { type: "done"; message: FamilyMessage; usage: FamilyUsage }
  | { type: "error"; message: string };
export interface FamilyError {
  error: string;
  code?: string;
}
export const FAMILY_NOTICE =
  "仅供受邀家人使用。管理员可查看账号、聊天内容、模型回复、用量和前台活跃时长估算。AI 回答可能有误。";
