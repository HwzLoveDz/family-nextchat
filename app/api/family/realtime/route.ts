import { upgradeWebSocket } from "@vercel/functions";
import { isFamilyMode, PRIVATE_API_HEADERS } from "@/app/family/enabled";
import { requireUser } from "@/app/family/server/auth";
import { rateLimit } from "@/app/family/server/accounts";
import {
  assertSameOrigin,
  bodyJson,
  fail,
  FamilyApiError,
  json,
} from "@/app/family/server/errors";
import { requireFamilyApplicationUpgrade } from "@/app/family/server/upgrades";
import {
  createRealtimeCall,
  claimRealtimeCall,
  releaseRealtimeConnection,
  endRealtimeCall,
} from "@/app/family/server/realtime-ledger";
import { startRealtimeRelay } from "@/app/family/server/realtime-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function configured() {
  if (!isFamilyMode()) throw new FamilyApiError(404, "Not found");
}
function refreshed(response: Response, headers: Headers) {
  for (const cookie of headers.getSetCookie())
    response.headers.append("set-cookie", cookie);
  return response;
}

export async function POST(request: Request) {
  try {
    configured();
    assertSameOrigin(request);
    const session = await requireUser(request);
    await requireFamilyApplicationUpgrade();
    await rateLimit(request, "realtime:start", 6, 60, session.user.id);
    const created = await createRealtimeCall(
      session.user.id,
      session.sessionId,
      await bodyJson(request, 2048),
    );
    return refreshed(json(created), session.authHeaders);
  } catch (error) {
    return fail(error);
  }
}

export async function GET(request: Request) {
  let context: Awaited<ReturnType<typeof claimRealtimeCall>> | undefined;
  try {
    configured();
    // GET upgrades also require an exact trusted Origin; a session cookie alone
    // must never authorize a cross-site WebSocket carrying microphone data.
    assertSameOrigin(request);
    const session = await requireUser(request);
    await requireFamilyApplicationUpgrade();
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return json(
        { error: "需要 WebSocket 连接。", code: "WEBSOCKET_REQUIRED" },
        426,
      );
    const query = new URL(request.url).searchParams;
    if (
      [...query.keys()].some((key) => key !== "callId") ||
      query.getAll("callId").length !== 1
    )
      throw new FamilyApiError(400, "通话参数无效。", "INVALID_REALTIME_CALL");
    await rateLimit(request, "realtime:connect", 12, 60, session.user.id);
    context = await claimRealtimeCall(
      session.user.id,
      session.sessionId,
      query.get("callId") ?? "",
    );
    const claimed = context;
    // Preserve the platform's upgrade response. Rebuilding it as an ordinary
    // Response loses the WebSocket callback; rolling cookies use POST above.
    return await upgradeWebSocket(
      async (peer) => {
        await startRealtimeRelay(peer, claimed);
      },
      { maxPayload: 16384 },
    );
  } catch (error) {
    if (context)
      await releaseRealtimeConnection(context, {
        resume: false,
        reason: "upgrade_failed",
        inputAudioSeconds: 0,
      }).catch(() => {});
    return fail(error);
  }
}

export async function DELETE(request: Request) {
  try {
    configured();
    assertSameOrigin(request);
    const session = await requireUser(request);
    await requireFamilyApplicationUpgrade();
    const body = await bodyJson(request, 1024);
    if (Object.keys(body).length !== 1 || typeof body.callId !== "string")
      throw new FamilyApiError(400, "通话参数无效。", "INVALID_REALTIME_CALL");
    await endRealtimeCall(session.user.id, session.sessionId, body.callId);
    return refreshed(
      Response.json({ ok: true }, { headers: PRIVATE_API_HEADERS }),
      session.authHeaders,
    );
  } catch (error) {
    return fail(error);
  }
}
