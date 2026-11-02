import { isFamilyMode, PRIVATE_API_HEADERS } from "@/app/family/enabled";
import { requireUser } from "@/app/family/server/auth";
import { rateLimit } from "@/app/family/server/accounts";
import { requireFamilyApplicationUpgrade } from "@/app/family/server/upgrades";
import { loadUsageDashboard } from "@/app/family/server/usage-dashboard";
import { fail, FamilyApiError, json } from "@/app/family/server/errors";
import type { UsageDashboardDays } from "@/app/family/usage-dashboard-types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function GET(request: Request) {
  let authHeaders: Headers | undefined;
  const finish = (response: Response) => {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(PRIVATE_API_HEADERS))
      headers.set(key, value);
    for (const cookie of authHeaders?.getSetCookie() ?? [])
      headers.append("set-cookie", cookie);
    return new Response(response.body, { status: response.status, headers });
  };
  try {
    if (!isFamilyMode()) return finish(json({ error: "Not found" }, 404));
    const session = await requireUser(request, true);
    authHeaders = session.authHeaders;
    await requireFamilyApplicationUpgrade();
    await rateLimit(request, "admin:usage-dashboard", 60, 60, session.user.id);
    const search = new URL(request.url).searchParams;
    if (
      [...search.keys()].some((key) => !["days", "userId"].includes(key)) ||
      search.getAll("days").length > 1 ||
      search.getAll("userId").length > 1
    )
      throw new FamilyApiError(400, "用量筛选无效。", "INVALID_USAGE_FILTER");
    const dayString = search.get("days") ?? "all";
    if (!["7", "30", "90", "all"].includes(dayString))
      throw new FamilyApiError(
        400,
        "请选择全部或最近 7、30、90 天。",
        "INVALID_USAGE_FILTER",
      );
    const userId = search.get("userId") ?? undefined;
    return finish(
      json(
        await loadUsageDashboard(
          (dayString === "all"
            ? "all"
            : Number(dayString)) as UsageDashboardDays,
          {
            actorId: session.user.id,
            admin: true,
            userId,
          },
        ),
      ),
    );
  } catch (error) {
    return finish(fail(error));
  }
}
