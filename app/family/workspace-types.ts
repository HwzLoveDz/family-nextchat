import type { FamilyMe, FamilyUser, FamilyAttachmentMeta } from "./types";
import type { FamilyTheme, FamilyThemeId } from "./themes";
import type { RealtimeVad, RealtimeVoice } from "./realtime-types";

export interface FamilySessionSummary {
  id: string;
  current: boolean;
  label: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
export interface FamilyFileSummary extends FamilyAttachmentMeta {
  chatId: string;
  chatTitle: string;
  chatArchived?: boolean;
  createdAt: string;
}
export interface FamilyFilePage {
  files: FamilyFileSummary[];
  nextCursor?: string | null;
}
export interface WorkspacePreferences {
  font: "small" | "standard" | "large";
  density: "comfortable" | "compact";
  sendKey: "enter" | "mod-enter";
}
export interface FamilySettingsProps {
  open: boolean;
  onClose: () => void;
  user: FamilyUser;
  expiresAt: string;
  theme: FamilyTheme;
  onThemeChange: (id: FamilyThemeId) => void;
  preferences: WorkspacePreferences;
  onPreferencesChange: (preferences: WorkspacePreferences) => void;
  voice: RealtimeVoice;
  onVoiceChange: (voice: RealtimeVoice) => void;
  vad: RealtimeVad;
  onVadChange: (vad: RealtimeVad) => void;
  voiceBusy: boolean;
  autoReadVoice: boolean;
  onAutoReadVoiceChange: (enabled: boolean) => void;
  tapRecord: boolean;
  onTapRecordChange: (enabled: boolean) => void;
  locked: boolean;
  onSaveProfile: (name: string) => Promise<FamilyMe>;
  onLoadSessions: () => Promise<{ sessions: FamilySessionSummary[] }>;
  onRevokeSession: (id: string) => Promise<void>;
  onRevokeOthers: () => Promise<void>;
  onLogout: () => void;
}
