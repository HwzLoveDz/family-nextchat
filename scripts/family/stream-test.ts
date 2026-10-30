import { OpenAIStreamDecoder } from "../../app/family/server/openai-stream";

let passed = 0;
function check(ok: unknown, name: string) {
  if (!ok) throw new Error(`FAIL ${name}`);
  passed++;
  console.log(`PASS ${name}`);
}
const frame = (data: unknown) => `data: ${JSON.stringify(data)}\r\n\r\n`;
const delta = (content: string) =>
  frame({ choices: [{ delta: { content }, finish_reason: null }] });
const encoder = new TextEncoder();
const events: string[] = [];
const complete = new OpenAIStreamDecoder((text) => events.push(text));
const bytes = encoder.encode(
  delta("你好") +
    delta("家人") +
    frame({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 7 } }) +
    "data: [DONE]\r\n\r\n",
);
for (const byte of bytes) complete.write(new Uint8Array([byte]));
complete.end();
check(
  complete.content === "你好家人" && events.join("") === complete.content,
  "actual gateway parser handles split UTF-8 and CRLF SSE",
);
check(
  complete.complete &&
    complete.usage.source === "reported" &&
    complete.usage.inputTokens === 5 &&
    complete.usage.outputTokens === 7,
  "actual gateway parser captures final upstream usage",
);
const truncated = new OpenAIStreamDecoder(() => {});
truncated.write(encoder.encode(delta("半段回复")));
let failed = false;
try {
  truncated.end();
} catch {
  failed = true;
}
check(
  failed && truncated.content === "半段回复",
  "truncated stream retains received partial output",
);
check(
  truncated.usage.source === "unknown" &&
    truncated.usage.inputTokens === null &&
    truncated.usage.outputTokens === null,
  "truncated stream unknown usage is never fabricated as zero",
);
for (const usage of [
  { prompt_tokens: -1, completion_tokens: 2 },
  { prompt_tokens: 5, completion_tokens: Number.MAX_SAFE_INTEGER + 1 },
  { prompt_tokens: 2 },
]) {
  const parser = new OpenAIStreamDecoder(() => {});
  parser.write(encoder.encode(frame({ usage }) + "data: [DONE]\n\n"));
  parser.end();
  check(
    parser.usage.source === "unknown",
    "invalid or incomplete token usage is rejected",
  );
}
const zero = new OpenAIStreamDecoder(() => {});
zero.write(
  encoder.encode(
    frame({ usage: { prompt_tokens: 0, completion_tokens: 0 } }) +
      "data: [DONE]\n\n",
  ),
);
zero.end();
check(
  zero.usage.source === "reported" && zero.usage.inputTokens === 0,
  "explicit reported zero remains distinct from unknown",
);
const rejected = new OpenAIStreamDecoder(() => {});
let safeError = "";
try {
  rejected.write(
    encoder.encode(
      frame({ error: { message: "fixture-sensitive-provider-body" } }),
    ),
  );
} catch (error) {
  safeError = (error as Error).message;
}
check(
  !!safeError && !safeError.includes("fixture-sensitive"),
  "upstream error content is not leaked",
);
const long = new OpenAIStreamDecoder(() => {});
let capped = false;
try {
  long.write(encoder.encode(delta("x".repeat(100_001))));
} catch {
  capped = true;
}
check(capped, "oversized model output is stopped");
const resolvedModel = new OpenAIStreamDecoder(() => {});
resolvedModel.write(
  encoder.encode(
    frame({
      model: "gpt-6.1-sol-2026-09-29",
      choices: [{ delta: { content: "已连接" }, finish_reason: null }],
    }) +
      frame({
        model: "gpt-6.1-sol-2026-09-29",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 9, completion_tokens: 4 },
      }) +
      "data: [DONE]\n\n",
  ),
);
resolvedModel.end();
check(
  resolvedModel.actualModel === "gpt-6.1-sol-2026-09-29" &&
    resolvedModel.finishReason === "stop",
  "actual upstream snapshot and finish reason are retained",
);
check(
  resolvedModel.usage.source === "reported" &&
    resolvedModel.usage.outputTokens === 4,
  "reasoning-model usage stays provider reported",
);
const unknownModel = new OpenAIStreamDecoder(() => {});
unknownModel.write(encoder.encode(delta("未报告模型") + "data: [DONE]\n\n"));
unknownModel.end();
check(
  unknownModel.actualModel === null,
  "missing actual upstream model is not fabricated from requested model",
);
const changedModel = new OpenAIStreamDecoder(() => {});
let changedRejected = false;
try {
  changedModel.write(
    encoder.encode(
      frame({ model: "gpt-4o-mini-2024-07-18" }) +
        frame({ model: "gpt-6.1-sol-2026-09-29" }),
    ),
  );
} catch {
  changedRejected = true;
}
check(changedRejected, "a stream cannot silently switch actual models");
const limited = new OpenAIStreamDecoder(() => {});
limited.write(
  encoder.encode(
    frame({
      choices: [{ delta: { content: "有限内容" }, finish_reason: "length" }],
      usage: { prompt_tokens: 3, completion_tokens: 2048 },
    }) + "data: [DONE]\n\n",
  ),
);
limited.end();
check(
  limited.finishReason === "length" &&
    limited.content === "有限内容" &&
    limited.usage.outputTokens === 2048,
  "token-limited reply retains finish reason, partial text and charged usage",
);
console.log(
  `Family upstream stream tests: ${passed} checks passed. Synthetic bytes only; no network, key or database used.`,
);
