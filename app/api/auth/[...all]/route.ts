import { isFamilyMode, PRIVATE_API_HEADERS } from "@/app/family/enabled";
import { getFamilyAuth } from "@/app/family/server/auth";
import {
  assertSameOrigin,
  bodyJson,
  fail,
  FamilyApiError,
  json,
} from "@/app/family/server/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request) {
  if (!isFamilyMode()) return json({ error: "Not found" }, 404);
  try {
    const path = new URL(request.url).pathname.replace(/^\/api\/auth\//, "");
    // The library's raw signup/admin/account mutation endpoints are never exposed.
    // Internal setup/register uses a distinct transaction-bound instance server-side.
    if (
      !(request.method === "GET" && path === "get-session") &&
      !(
        request.method === "POST" &&
        (path === "sign-in/email" || path === "sign-out")
      )
    ) {
      throw new FamilyApiError(404, "接口不存在。");
    }
    let forwarded = request;
    if (request.method === "POST") {
      assertSameOrigin(request);
      const body = await bodyJson(request, 8192);
      if (path === "sign-in/email") body.rememberMe = true;
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      forwarded = new Request(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    }
    const response = await getFamilyAuth().handler(forwarded);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(PRIVATE_API_HEADERS))
      headers.set(key, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    return fail(error);
  }
}
export const GET = handle;
export const POST = handle;
