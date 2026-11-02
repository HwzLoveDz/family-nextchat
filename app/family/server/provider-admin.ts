import "server-only";
import { isFamilyMode, PRIVATE_API_HEADERS } from "../enabled";
import type { ProviderAdminSnapshot } from "../provider-admin-types";
import { requireUser } from "./auth";
import { rateLimit } from "./accounts";
import { configuredProviderKeys } from "./provider-keys";
import { getProviderPolicyState, saveProviderPolicy } from "./provider-policy";
import {
  providerObservations,
  refreshProviderBalances,
} from "./provider-observations";
import { requireFamilyApplicationUpgrade } from "./upgrades";
import {
  assertSameOrigin,
  bodyJson,
  fail,
  FamilyApiError,
  json,
} from "./errors";

export async function providerAdminSnapshot(): Promise<ProviderAdminSnapshot> {
  const completed = await Promise.allSettled([
    getProviderPolicyState(),
    providerObservations(configuredProviderKeys()),
  ] as const);
  const [policyResult, observationResult] = completed;
  if (policyResult.status === "rejected") throw policyResult.reason;
  if (observationResult.status === "rejected") throw observationResult.reason;
  const policy = policyResult.value;
  const observations = observationResult.value;
  return {
    revision: policy.revision,
    updatedAt: policy.updatedAt,
    providers: policy.keys.map((key) => ({
      id: key.id,
      name: key.name,
      tier: key.tier,
      enabled: key.enabled,
      order: key.position,
      balance: observations.get(key.id)?.balance ?? {
        state: "unchecked",
        remainingUSD: null,
        checkedAt: null,
        scope: "organization",
      },
      activity: observations.get(key.id)?.activity ?? {
        state: "unobserved",
        checkedAt: null,
      },
    })),
  };
}

export async function handleProviderAdmin(
  request: Request,
  refresh = false,
): Promise<Response> {
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
    if (request.method !== "GET") assertSameOrigin(request);
    const session = await requireUser(request, true);
    authHeaders = session.authHeaders;
    await requireFamilyApplicationUpgrade();
    if (!refresh && request.method === "GET") {
      await rateLimit(request, "admin:provider-read", 60, 60, session.user.id);
      return finish(json(await providerAdminSnapshot()));
    }
    if (!refresh && request.method === "PATCH") {
      await rateLimit(
        request,
        "admin:provider-policy",
        10,
        60,
        session.user.id,
      );
      const body = await bodyJson(request, 4096);
      if (
        Object.keys(body).some(
          (key) => !["order", "disabled", "expectedRevision"].includes(key),
        ) ||
        !Array.isArray(body.order) ||
        !Array.isArray(body.disabled) ||
        body.order.length > 9 ||
        body.disabled.length > 9 ||
        !body.order.every((id) => typeof id === "string") ||
        !body.disabled.every((id) => typeof id === "string") ||
        !Number.isSafeInteger(body.expectedRevision) ||
        Number(body.expectedRevision) < 0
      )
        throw new FamilyApiError(
          400,
          "API 顺序设置无效，请重新加载后再试。",
          "INVALID_PROVIDER_POLICY",
        );
      await saveProviderPolicy(
        body.order as string[],
        body.disabled as string[],
        body.expectedRevision as number,
        session.user.id,
      );
      return finish(json(await providerAdminSnapshot()));
    }
    if (refresh && request.method === "POST") {
      await rateLimit(
        request,
        "admin:provider-refresh",
        12,
        60,
        session.user.id,
      );
      const body = await bodyJson(request, 1024);
      if (
        Object.keys(body).some((key) => key !== "force") ||
        (body.force !== undefined && typeof body.force !== "boolean")
      )
        throw new FamilyApiError(
          400,
          "余额刷新参数无效。",
          "INVALID_PROVIDER_REFRESH",
        );
      await refreshProviderBalances(
        configuredProviderKeys(),
        body.force === true,
        request.signal,
      );
      return finish(json(await providerAdminSnapshot()));
    }
    throw new FamilyApiError(404, "接口不存在。");
  } catch (error) {
    return finish(fail(error));
  }
}
