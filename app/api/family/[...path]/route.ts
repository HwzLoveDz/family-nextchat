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
  listChatPage,
  newChat,
  updateChat,
  cancelGeneration,
  validId,
} from "@/app/family/server/chats";
import { listWorkspaceFiles } from "@/app/family/server/workspace-files";
import { readGeneratedImage } from "@/app/family/server/generated-images";
import { modelCatalog } from "@/app/family/server/models";
import { getProviderPolicyState } from "@/app/family/server/provider-policy";
import {
  ATTACHMENT_REQUEST_LIMIT,
  readAttachment,
} from "@/app/family/server/attachments";
import {
  ensureFamilyApplicationUpgrade,
  requireFamilyApplicationUpgrade,
  FAMILY_APPLICATION_SCHEMA_VERSION,
} from "@/app/family/server/upgrades";
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
export const maxDuration = 300;

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
    if (method === "POST" && joined === "admin/migrate") {
      await rateLimit(request, "admin:migrate", 5, 60, userId);
      await ensureFamilyApplicationUpgrade();
      await audit(userId, "schema.upgrade");
      return finish(
        json({ ok: true, schemaVersion: FAMILY_APPLICATION_SCHEMA_VERSION }),
      );
    }
    if (
      path[0] === "chats" ||
      path[0] === "attachments" ||
      path[0] === "generated-images" ||
      path[0] === "files" ||
      joined === "models" ||
      (path[0] === "admin" &&
        (path.includes("chats") ||
          path.includes("attachments") ||
          path.includes("generated-images")))
    )
      await requireFamilyApplicationUpgrade();
    if (method === "GET" && joined === "models")
      return finish(json(modelCatalog()));
    if (
      method === "GET" &&
      ((path[0] === "generated-images" && path.length === 2) ||
        (path[0] === "admin" &&
          path[1] === "generated-images" &&
          path.length === 3))
    ) {
      const admin = path[0] === "admin";
      const saved = await readGeneratedImage(
        validId(path[admin ? 2 : 1]),
        admin ? undefined : userId,
      );
      if (admin)
        await audit(
          userId,
          "generated-image.content.read",
          saved.ownerId,
          saved.chatId,
        );
      return finish(
        new Response(new Uint8Array(saved.bytes), {
          headers: {
            "Content-Type": "image/jpeg",
            "Content-Length": String(saved.bytes.length),
            "Content-Disposition": `inline; filename="generated-image.jpg"; filename*=UTF-8''${encodeURIComponent(
              saved.meta.name,
            )}`,
          },
        }),
      );
    }
    if (
      method === "GET" &&
      ((path[0] === "attachments" && path.length === 2) ||
        (path[0] === "admin" && path[1] === "attachments" && path.length === 3))
    ) {
      const admin = path[0] === "admin";
      const saved = await readAttachment(
        validId(path[admin ? 2 : 1]),
        admin ? undefined : userId,
      );
      if (admin)
        await audit(
          userId,
          "attachment.content.read",
          saved.ownerId,
          saved.chatId,
        );
      return finish(
        new Response(new Uint8Array(saved.bytes), {
          headers: {
            "Content-Type": saved.meta.mediaType,
            "Content-Length": String(saved.bytes.length),
            "Content-Disposition": `${
              saved.meta.kind === "image" ? "inline" : "attachment"
            }; filename="attachment"; filename*=UTF-8''${encodeURIComponent(
              saved.meta.name,
            ).replace(
              /[!'()*]/g,
              (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
            )}`,
          },
        }),
      );
    }
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
        return finish(
          json(
            await listChatPage(userId, {
              q: new URL(request.url).searchParams.get("q"),
              view: new URL(request.url).searchParams.get("view"),
              cursor: new URL(request.url).searchParams.get("cursor"),
            }),
          ),
        );
      if (method === "POST")
        return finish(
          json({ chat: await newChat(userId, await bodyJson(request, 2048)) }),
        );
    }
    if (path[0] === "chats" && path.length === 2) {
      if (method === "PATCH") {
        await rateLimit(request, "chat:update", 30, 60, userId);
        return finish(
          json({
            chat: await updateChat(
              path[1],
              userId,
              await bodyJson(request, 2048),
            ),
          }),
        );
      }
      if (method === "GET")
        return finish(
          json(
            await chatDetail(
              path[1],
              userId,
              false,
              new URL(request.url).searchParams.get("before"),
            ),
          ),
        );
      if (method === "DELETE")
        return finish(json(await deleteChat(path[1], userId)));
    }
    if (method === "GET" && joined === "files") {
      const params = new URL(request.url).searchParams;
      return finish(
        json(
          await listWorkspaceFiles(userId, {
            q: params.get("q"),
            chatId: params.get("chatId"),
            cursor: params.get("cursor"),
          }),
        ),
      );
    }
    if (
      method === "POST" &&
      path[0] === "chats" &&
      path.length === 5 &&
      path[2] === "messages" &&
      path[4] === "cancel"
    )
      return finish(json(await cancelGeneration(path[1], userId, path[3])));
    if (
      method === "POST" &&
      path[0] === "chats" &&
      path.length === 3 &&
      path[2] === "messages"
    ) {
      return finish(
        await generate(
          request,
          userId,
          path[1],
          await bodyJson(request, ATTACHMENT_REQUEST_LIMIT),
        ),
      );
    }
    if (method === "POST" && joined === "activity")
      return finish(
        json(
          await recordActivity(userId, (await bodyJson(request, 1024)).eventId),
        ),
      );
    if (path[0] === "admin") {
      if (method === "GET" && joined === "admin/users") {
        await requireFamilyApplicationUpgrade();
        return finish(
          json({
            users: await listUsers(),
            providerKeys: (await getProviderPolicyState()).keys
              .filter((key) => key.enabled)
              .map(({ name, tier }) => ({ name, tier })),
          }),
        );
      }
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
        const detail = await chatDetail(
          path[2],
          undefined,
          true,
          new URL(request.url).searchParams.get("before"),
        );
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
