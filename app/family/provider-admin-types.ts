/** Admin JSON contracts. Never add raw credentials or upstream response bodies. */
export type ProviderBalanceState =
  | "available"
  | "permission_denied"
  | "unsupported"
  | "unavailable"
  | "unchecked";
export interface ProviderBalance {
  state: ProviderBalanceState;
  remainingUSD: number | null;
  checkedAt: string | null;
  scope: "organization";
}
export interface ProviderRuntimeObservation {
  state: "unobserved" | "accepted" | "quota_limited";
  checkedAt: string | null;
}
export interface ProviderAdminItem {
  id: string;
  name: string;
  tier: "priority" | "fallback";
  enabled: boolean;
  order: number;
  balance: ProviderBalance;
  activity: ProviderRuntimeObservation;
}
export interface ProviderAdminSnapshot {
  revision: number;
  updatedAt: string | null;
  providers: ProviderAdminItem[];
}
export interface ProviderPolicyInput {
  order: string[];
  disabled: string[];
  expectedRevision: number;
}
