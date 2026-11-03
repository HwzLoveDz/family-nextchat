export const FAMILY_REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type FamilyReasoningEffort = (typeof FAMILY_REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: FamilyReasoningEffort = "low";
