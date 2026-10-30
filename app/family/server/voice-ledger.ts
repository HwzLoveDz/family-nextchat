import "server-only";
import { randomUUID } from "node:crypto";
import { transaction } from "./db";
import { FamilyApiError } from "./errors";

type VoiceKind = "transcribe" | "speech";
export interface VoiceOperationStart {
  requestId: string;
  kind: VoiceKind;
  requestedModel: string;
  chatId?: string | null;
  messageId?: string | null;
  part?: number | null;
  audioSeconds?: number | null;
}
export interface VoiceOperationFinish {
  state: "complete" | "error";
  actualModel?: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  usageSource: "reported" | "unknown";
  audioSeconds?: number | null;
  reportedAudioSeconds?: number | null;
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const modelId = /^[a-zA-Z0-9._:-]{1,200}$/;
function invalid(): never {
  throw new FamilyApiError(400, "语音请求参数无效。", "INVALID_VOICE_METADATA");
}
function duration(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 75
  )
    invalid();
  return value;
}

/** Admission metadata only. Callers validate ownership and media before admission. */
export async function beginVoiceOperation(
  userId: string,
  input: VoiceOperationStart,
): Promise<{ id: string }> {
  if (
    !uuid.test(input.requestId) ||
    !["transcribe", "speech"].includes(input.kind) ||
    typeof input.requestedModel !== "string" ||
    !modelId.test(input.requestedModel) ||
    (input.chatId != null && !uuid.test(input.chatId)) ||
    (input.messageId != null &&
      (!input.chatId || !uuid.test(input.messageId))) ||
    (input.part != null &&
      (!Number.isSafeInteger(input.part) || input.part < 0 || input.part > 9))
  )
    invalid();
  const audioSeconds = duration(input.audioSeconds);
  const admitted = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `family-voice:${userId}`,
    ]);
    const approved = await client.query(
      'SELECT id FROM "user" WHERE id=$1 AND status=$2 FOR SHARE',
      [userId, "approved"],
    );
    if (!approved.rowCount)
      throw new FamilyApiError(
        403,
        "账号尚未获批或已停用。",
        "ACCOUNT_UNAVAILABLE",
      );
    if (
      (
        await client.query(
          "SELECT id FROM family_voice_usage WHERE user_id=$1 AND request_id=$2",
          [userId, input.requestId],
        )
      ).rowCount
    )
      throw new FamilyApiError(
        409,
        "此语音请求已提交，请勿重复发送。",
        "VOICE_REQUEST_EXISTS",
      );
    await client.query(
      "UPDATE family_voice_usage SET state='error',finished_at=now(),input_tokens=NULL,output_tokens=NULL,usage_source='unknown' WHERE user_id=$1 AND state='running' AND started_at<now()-interval '60 seconds'",
      [userId],
    );
    const running = await client.query(
      "SELECT count(*)::int AS count FROM family_voice_usage WHERE user_id=$1 AND state='running'",
      [userId],
    );
    if (running.rows[0].count >= 2) return null;
    const id = randomUUID();
    await client.query(
      "INSERT INTO family_voice_usage(id,user_id,request_id,kind,state,requested_model,chat_id,message_id,part_index,audio_seconds) VALUES($1,$2,$3,$4,'running',$5,$6,$7,$8,$9)",
      [
        id,
        userId,
        input.requestId,
        input.kind,
        input.requestedModel,
        input.chatId ?? null,
        input.messageId ?? null,
        input.part ?? null,
        audioSeconds,
      ],
    );
    return { id };
  });
  if (!admitted)
    throw new FamilyApiError(
      429,
      "已有语音请求正在处理，请稍后再试。",
      "VOICE_BUSY",
    );
  return admitted;
}

/** Terminal ledger updates never store media, transcript text, or provider error bodies. */
export async function finishVoiceOperation(
  id: string,
  input: VoiceOperationFinish,
): Promise<void> {
  if (!uuid.test(id) || !["complete", "error"].includes(input.state)) invalid();
  const audioSeconds = duration(input.audioSeconds);
  const reportedAudioSeconds = duration(input.reportedAudioSeconds);
  const reported =
    input.usageSource === "reported" &&
    [input.inputTokens, input.outputTokens].every(
      (value) => Number.isSafeInteger(value) && value !== null && value >= 0,
    );
  const actualModel =
    typeof input.actualModel === "string" && modelId.test(input.actualModel)
      ? input.actualModel
      : null;
  await transaction(async (client) => {
    const row = (
      await client.query(
        "SELECT state FROM family_voice_usage WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!row)
      throw new FamilyApiError(
        404,
        "语音请求不存在。",
        "VOICE_REQUEST_NOT_FOUND",
      );
    if (row.state !== "running") return;
    await client.query(
      "UPDATE family_voice_usage SET state=$1,actual_model=$2,input_tokens=$3,output_tokens=$4,usage_source=$5,audio_seconds=COALESCE($6,audio_seconds),reported_audio_seconds=COALESCE($7,reported_audio_seconds),finished_at=now() WHERE id=$8",
      [
        input.state,
        actualModel,
        reported ? input.inputTokens : null,
        reported ? input.outputTokens : null,
        reported ? "reported" : "unknown",
        audioSeconds,
        reportedAudioSeconds,
        id,
      ],
    );
  });
}
