import "server-only";
import { getPool } from "./db";
import { FamilyApiError, bodyJson } from "./errors";
import { beginVoiceOperation, finishVoiceOperation } from "./voice-ledger";
import { validateVoiceWav, VOICE_INPUT_MAX, speechParts } from "./voice-media";
import {
  newVoiceEvidence,
  requestSpeech,
  requestTranscription,
  SPEECH_MODEL,
  TRANSCRIBE_MODEL,
  type VoiceEvidence,
} from "./voice-provider";
import type { FamilyUsage } from "../types";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function id(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value))
    throw new FamilyApiError(400, "语音请求编号无效。", "INVALID_VOICE_ID");
  return value;
}
function providerKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key)
    throw new FamilyApiError(
      503,
      "管理员尚未配置语音服务。",
      "VOICE_NOT_CONFIGURED",
    );
  return key;
}
async function assertVoiceAccess(
  userId: string,
  chatId?: string,
  messageId?: string,
): Promise<void> {
  const approved = await getPool().query(
    'SELECT 1 FROM "user" WHERE id=$1 AND status=$2',
    [userId, "approved"],
  );
  if (!approved.rowCount)
    throw new FamilyApiError(
      403,
      "账号尚未获批或已停用。",
      "ACCOUNT_UNAVAILABLE",
    );
  if (!chatId) return;
  const owner = await getPool().query(
    "SELECT 1 FROM family_chat WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
    [chatId, userId],
  );
  if (!owner.rowCount)
    throw new FamilyApiError(404, "对话不存在。", "CHAT_NOT_FOUND");
  if (messageId) {
    const saved = await getPool().query(
      "SELECT 1 FROM family_message m JOIN family_generation g ON g.id=m.generation_id WHERE m.id=$1 AND m.chat_id=$2 AND g.user_id=$3 AND m.role='assistant' AND m.status IN ('complete','partial') AND g.state IN ('complete','partial') AND g.superseded_at IS NULL",
      [messageId, chatId, userId],
    );
    if (!saved.rowCount)
      throw new FamilyApiError(
        404,
        "这条回复当前不可朗读。",
        "MESSAGE_NOT_FOUND",
      );
  }
}

/** Finite per-operation timer/poll; never a persistent watcher or browser connection. */
function voiceLifetime(
  request: Request,
  userId: string,
  chatId?: string,
  messageId?: string,
) {
  const controller = new AbortController();
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  const cancel = () =>
    controller.abort(
      new FamilyApiError(499, "语音请求已取消。", "VOICE_CANCELLED"),
    );
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new FamilyApiError(504, "语音处理超时，请稍后再试。", "VOICE_TIMEOUT"),
      ),
    35_000,
  );
  const poll = setInterval(() => {
    if (!inFlight && !controller.signal.aborted) {
      const pending = assertVoiceAccess(userId, chatId, messageId).catch(
        (error) => {
          controller.abort(
            error instanceof FamilyApiError
              ? error
              : new FamilyApiError(
                  503,
                  "语音权限暂时无法确认。",
                  "VOICE_ACCESS_UNAVAILABLE",
                ),
          );
        },
      );
      inFlight = pending;
      void pending.finally(() => {
        if (inFlight === pending) inFlight = undefined;
      });
    }
  }, 2000);
  return {
    signal: controller.signal,
    async stop() {
      if (!stopped) {
        stopped = true;
        clearTimeout(timeout);
        clearInterval(poll);
        request.signal.removeEventListener("abort", cancel);
      }
      await inFlight;
    },
    error(error: unknown): unknown {
      return controller.signal.aborted &&
        controller.signal.reason instanceof FamilyApiError
        ? controller.signal.reason
        : error;
    },
  };
}

async function readMultipart(request: Request): Promise<FormData> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("multipart/form-data;")
  )
    throw new FamilyApiError(
      415,
      "请上传 WAV 录音。",
      "VOICE_MULTIPART_REQUIRED",
    );
  const size = Number(request.headers.get("content-length"));
  if (Number.isFinite(size) && size > 1_480_000)
    throw new FamilyApiError(413, "录音文件过大。", "VOICE_INPUT_LIMIT");
  if (!request.body)
    throw new FamilyApiError(400, "录音内容为空。", "VOICE_INPUT_EMPTY");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.length;
      if (total > 1_480_000) {
        await reader.cancel();
        throw new FamilyApiError(413, "录音文件过大。", "VOICE_INPUT_LIMIT");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return await new Response(bytes, {
      headers: { "content-type": request.headers.get("content-type")! },
    }).formData();
  } catch {
    throw new FamilyApiError(
      400,
      "录音提交格式无效。",
      "VOICE_MULTIPART_INVALID",
    );
  }
}
function voiceHeaders(
  evidence: VoiceEvidence,
  requestedModel: string,
): Record<string, string> {
  return {
    "X-Family-Voice-Usage": JSON.stringify(evidence.usage),
    "X-Family-Voice-Model": evidence.actualModel
      ? `reported:${evidence.actualModel}`
      : `requested:${requestedModel}`,
  };
}
async function finishOperation(
  operationId: string,
  state: "complete" | "error",
  evidence: VoiceEvidence,
) {
  await finishVoiceOperation(operationId, {
    state,
    actualModel: evidence.actualModel,
    usageSource: evidence.usage.source,
    inputTokens: evidence.usage.inputTokens,
    outputTokens: evidence.usage.outputTokens,
    audioSeconds: evidence.audioSeconds,
    reportedAudioSeconds: evidence.reportedAudioSeconds,
  });
}

export async function transcribeVoice(
  request: Request,
  userId: string,
): Promise<Response> {
  const form = await readMultipart(request);
  if (
    [...form.keys()].some(
      (name) => !["audio", "requestId", "chatId"].includes(name),
    ) ||
    ["audio", "requestId", "chatId"].some(
      (name) => form.getAll(name).length > 1,
    )
  )
    throw new FamilyApiError(
      400,
      "录音请求参数无效。",
      "INVALID_VOICE_PARAMETERS",
    );
  const requestId = id(form.get("requestId"));
  const chatId = form.has("chatId") ? id(form.get("chatId")) : undefined;
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size > VOICE_INPUT_MAX)
    throw new FamilyApiError(
      400,
      "请上传有效的 WAV 录音。",
      "INVALID_VOICE_WAV",
    );
  const wav = new Uint8Array(await audio.arrayBuffer());
  const { audioSeconds } = validateVoiceWav(wav);
  await assertVoiceAccess(userId, chatId);
  const key = providerKey();
  const operation = await beginVoiceOperation(userId, {
    requestId,
    kind: "transcribe",
    requestedModel: TRANSCRIBE_MODEL,
    chatId,
    audioSeconds,
  });
  const lifetime = voiceLifetime(request, userId, chatId);
  const evidence = newVoiceEvidence();
  evidence.audioSeconds = audioSeconds;
  let state: "complete" | "error" = "error";
  try {
    const text = await requestTranscription(
      key,
      wav,
      lifetime.signal,
      evidence,
    );
    await lifetime.stop();
    if (lifetime.signal.aborted) throw lifetime.signal.reason;
    await assertVoiceAccess(userId, chatId);
    state = "complete";
    return Response.json(
      { text, usage: evidence.usage satisfies FamilyUsage },
      { headers: voiceHeaders(evidence, TRANSCRIBE_MODEL) },
    );
  } catch (error) {
    throw lifetime.error(error);
  } finally {
    await lifetime.stop();
    await finishOperation(operation.id, state, evidence);
  }
}

export async function speakVoice(
  request: Request,
  userId: string,
): Promise<Response> {
  const body = await bodyJson(request, 2048);
  if (
    Object.keys(body).some(
      (key) => !["chatId", "messageId", "requestId", "part"].includes(key),
    )
  )
    throw new FamilyApiError(
      400,
      "朗读请求参数无效。",
      "INVALID_VOICE_PARAMETERS",
    );
  const requestId = id(body.requestId);
  const chatId = id(body.chatId);
  const messageId = id(body.messageId);
  const part = body.part === undefined ? 0 : body.part;
  if (
    typeof part !== "number" ||
    !Number.isSafeInteger(part) ||
    part < 0 ||
    part > 9
  )
    throw new FamilyApiError(400, "朗读段落编号无效。", "INVALID_VOICE_PART");
  await assertVoiceAccess(userId, chatId, messageId);
  const saved = (
    await getPool().query(
      "SELECT m.content FROM family_message m JOIN family_generation g ON g.id=m.generation_id JOIN family_chat c ON c.id=m.chat_id WHERE m.id=$1 AND m.chat_id=$2 AND c.user_id=$3 AND c.deleted_at IS NULL AND g.user_id=$3 AND m.role='assistant' AND m.status IN ('complete','partial') AND g.state IN ('complete','partial') AND g.superseded_at IS NULL",
      [messageId, chatId, userId],
    )
  ).rows[0];
  if (!saved)
    throw new FamilyApiError(
      404,
      "这条回复当前不可朗读。",
      "MESSAGE_NOT_FOUND",
    );
  const { parts, truncated } = speechParts(saved.content);
  if (part >= parts.length)
    throw new FamilyApiError(400, "朗读段落不存在。", "INVALID_VOICE_PART");
  const key = providerKey();
  const operation = await beginVoiceOperation(userId, {
    requestId,
    kind: "speech",
    requestedModel: SPEECH_MODEL,
    chatId,
    messageId,
    part,
  });
  const lifetime = voiceLifetime(request, userId, chatId, messageId);
  const evidence = newVoiceEvidence();
  let state: "complete" | "error" = "error";
  try {
    const wav = await requestSpeech(
      key,
      parts[part],
      lifetime.signal,
      evidence,
    );
    await lifetime.stop();
    if (lifetime.signal.aborted) throw lifetime.signal.reason;
    await assertVoiceAccess(userId, chatId, messageId);
    state = "complete";
    return new Response(new Uint8Array(wav), {
      headers: {
        ...voiceHeaders(evidence, SPEECH_MODEL),
        "Content-Type": "audio/wav",
        "Content-Length": String(wav.length),
        "X-Family-Voice-Parts": String(parts.length),
        "X-Family-Voice-Part": String(part),
        "X-Family-Voice-Truncated": truncated ? "1" : "0",
      },
    });
  } catch (error) {
    throw lifetime.error(error);
  } finally {
    await lifetime.stop();
    await finishOperation(operation.id, state, evidence);
  }
}
