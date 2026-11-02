export type UsageDashboardDays = 7 | 30 | 90 | "all";
export interface UsageDashboardCounters {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  reportedRequests: number;
  unknownRequests: number;
  runningRequests: number;
  cost?: {
    estimatedUSD: number | null;
    pricedRequests: number;
    unpricedRequests: number;
    priceVersion: string;
  };
}
export interface UsageDashboardData {
  days: UsageDashboardDays;
  trendDays: 7 | 30 | 90;
  scope: "self" | "admin";
  timezone: "Asia/Shanghai";
  from: string;
  to: string;
  updatedAt: string;
  selectedUserId: string | null;
  members: { id: string; name: string }[];
  membersTruncated: boolean;
  summary: UsageDashboardCounters;
  daily: (UsageDashboardCounters & { date: string })[];
  models: (UsageDashboardCounters & {
    id: string;
    model: string | null;
    label: string;
    source: "reported" | "requested" | "mixed";
  })[];
  people: (UsageDashboardCounters & { id: string | null; name: string })[];
}
