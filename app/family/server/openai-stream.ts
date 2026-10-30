import "server-only";
import { FamilyApiError } from "./errors";
import type { FamilyUsage } from "../types";

/** Incremental UTF-8/SSE parser used by the actual server gateway and offline fixtures. */
export class OpenAIStreamDecoder {
  private decoder = new TextDecoder();
  private buffer = "";
  content = "";
  complete = false;
  usage: FamilyUsage = {
    source: "unknown",
    inputTokens: null,
    outputTokens: null,
  };
  constructor(private onDelta: (text: string) => void) {}
  write(bytes: Uint8Array) {
    this.feed(this.decoder.decode(bytes, { stream: true }));
  }
  end() {
    this.feed(this.decoder.decode());
    if (this.buffer.trim()) this.frame(this.buffer);
    this.buffer = "";
    if (!this.complete)
      throw new FamilyApiError(502, "回复已中断，已保存收到的内容。");
  }
  private feed(value: string) {
    this.buffer = (this.buffer + value).replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\n\n")) >= 0) {
      this.frame(this.buffer.slice(0, boundary));
      this.buffer = this.buffer.slice(boundary + 2);
    }
    if (this.buffer.length > 1_000_000)
      throw new FamilyApiError(502, "模型返回格式无效。");
  }
  private frame(frame: string) {
    const raw = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!raw) return;
    if (raw.trim() === "[DONE]") {
      this.complete = true;
      return;
    }
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new FamilyApiError(502, "模型返回格式无效。");
    }
    if (data.error) throw new FamilyApiError(502, "模型服务中断，请稍后重试。");
    if (
      data.usage &&
      Number.isSafeInteger(data.usage.prompt_tokens) &&
      Number.isSafeInteger(data.usage.completion_tokens) &&
      data.usage.prompt_tokens >= 0 &&
      data.usage.completion_tokens >= 0
    ) {
      this.usage = {
        source: "reported",
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      };
    }
    const delta = data.choices?.[0]?.delta?.content;
    if (typeof delta === "string") {
      this.content += delta;
      if (this.content.length > 100_000)
        throw new FamilyApiError(502, "回复过长，已停止生成。");
      this.onDelta(delta);
    }
    if (data.choices?.[0]?.finish_reason) this.complete = true;
  }
}
