import { isFamilyMode, PRIVATE_API_HEADERS } from "@/app/family/enabled";
import { requireUser } from "@/app/family/server/auth";
import {
  audit,
  createInvite,
  listUsers,
  rateLimit,
  recordActivity,
  register,
  setup,
  siteStatus,
  updateUser,
} from "@/app/family/server/accounts";
import {
  chatDetail,
  deleteChat,
  generate,
  listChats,
  newChat,
} from "@/app/family/server/chats";
import {
  assertSameOrigin,
  bodyJson,
  fail,
  FamilyApiError,
  json,
} from "@/app/family/server/errors";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  if (!isFamilyMode()) return json({ error: "Not found" }, 404);
  let authHeaders: Headers | undefined;
  const finish = (response: Response) => {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(PRIVATE_API_HEADERS))
      headers.set(key, value);
    // Propagate rolling session cookie expiry on every authenticated route, including SSE.
    if (authHeaders)
      for (const cookie of authHeaders.getSetCookie())
        headers.append("set-cookie", cookie);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  try {
    const { path } = await context.params;
    const joined = path.join("/");
    const method = request.method;
    if (method === "GET" && joined === "status")
      return json(await siteStatus());
    if (method !== "GET") assertSameOrigin(request);
    if (method === "POST" && joined === "setup") {
      return json(await setup(await bodyJson(request, 4096), request));
    }
    if (method === "POST" && joined === "register") {
      await rateLimit(request, "register", 10, 3600);
      return json(await register(await bodyJson(request, 4096)));
    }
    const session = await requireUser(request, path[0] === "admin");
    authHeaders = session.authHeaders;
    const userId = session.user.id;
    if (method === "GET" && joined === "me")
      return finish(
        json({
          user: session.user,
          sessionExpiresAt: session.sessionExpiresAt,
        }),
      );
    if (method === "POST")
      await rateLimit(
        request,
        `family:${path[0]}`,
        path[0] === "activity" ? 12 : 30,
        60,
        userId,
      );
    if (joined === "chats") {
      if (method === "GET")
        return finish(json({ chats: await listChats(userId) }));
      if (method === "POST")
        return finish(
          json({ chat: await newChat(userId, await bodyJson(request, 2048)) }),
        );
    }
    if (path[0] === "chats" && path.length === 2) {
      if (method === "GET")
        return finish(json(await chatDetail(path[1], userId)));
      if (method === "DELETE")
        return finish(json(await deleteChat(path[1], userId)));
    }
    if (
      method === "POST" &&
      path[0] === "chats" &&
      path.length === 3 &&
      path[2] === "messages"
    ) {
      return finish(
        await generate(request, userId, path[1], await bodyJson(request)),
      );
    }
    if (method === "POST" && joined === "activity")
      return finish(
        json(
          await recordActivity(userId, (await bodyJson(request, 1024)).eventId),
        ),
      );
    if (path[0] === "admin") {
      if (method === "GET" && joined === "admin/users")
        return finish(json({ users: await listUsers() }));
      if (method === "POST" && joined === "admin/invites")
        return finish(
          json(await createInvite(userId, await bodyJson(request, 1024))),
        );
      if (method === "PATCH" && path[1] === "users" && path.length === 3) {
        await rateLimit(request, "admin:status", 30, 60, userId);
        return finish(
          json(
            await updateUser(
              userId,
              path[2],
              (await bodyJson(request, 1024)).status,
            ),
          ),
        );
      }
      if (
        method === "GET" &&
        path[1] === "users" &&
        path[3] === "chats" &&
        path.length === 4
      ) {
        await audit(userId, "user.chats.read", path[2]);
        return finish(json({ chats: await listChats(path[2], true) }));
      }
      if (method === "GET" && path[1] === "chats" && path.length === 3) {
        const detail = await chatDetail(path[2], undefined, true);
        await audit(userId, "chat.content.read", undefined, path[2]);
        return finish(json(detail));
      }
    }
    throw new FamilyApiError(404, "接口不存在。");
  } catch (error) {
    return finish(fail(error));
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
