import { isFamilyMode, PRIVATE_API_HEADERS } from "@/app/family/enabled";
import { requireUser } from "@/app/family/server/auth";
import { rateLimit } from "@/app/family/server/accounts";
import { requireFamilyApplicationUpgrade } from "@/app/family/server/upgrades";
import { assertSameOrigin, fail, json } from "@/app/family/server/errors";
import { speakVoice, transcribeVoice } from "@/app/family/server/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
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
    if (request.method !== "POST")
      return finish(json({ error: "接口不存在。" }, 405));
    assertSameOrigin(request);
    const session = await requireUser(request);
    authHeaders = session.authHeaders;
    await requireFamilyApplicationUpgrade();
    const { path } = await context.params;
    if (path.length !== 1 || !["transcribe", "speech"].includes(path[0]))
      return finish(json({ error: "接口不存在。" }, 404));
    await rateLimit(
      request,
      `voice:${path[0]}`,
      path[0] === "transcribe" ? 10 : 30,
      60,
      session.user.id,
    );
    return finish(
      await (path[0] === "transcribe"
        ? transcribeVoice(request, session.user.id)
        : speakVoice(request, session.user.id)),
    );
  } catch (error) {
    return finish(fail(error));
  }
}
export const POST = handle;
export const GET = handle;
