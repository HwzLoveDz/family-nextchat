// Brief selection guidance based on official model pages checked 2026-11-03:
// https://developers.openai.com/api/docs/models/{model-id}
// Descriptions refer to the capabilities exposed by this chat workspace.
export const MODEL_DESCRIPTIONS: Readonly<Record<string, string>> =
  Object.freeze({
    "gpt-4o-mini": "日常问答，轻快省用量",
    "gpt-4.1-nano": "简短问答，速度优先",
    "gpt-4.1-mini": "文字整理，兼顾速度与成本",
    "gpt-4.1": "代码与长文，重视指令细节",
    "gpt-4o": "通用问答与写作",
    "gpt-5.4-mini": "日常任务，兼顾速度与推理",
    "gpt-6-luna": "轻量问答，注重效率",
    "gpt-6.1-terra": "看图理解与自然写作",
    "gpt-6.1-sol": "复杂代码与多步骤推理",
    "gpt-6-astra": "复杂问题与多步骤分析",
    "gpt-image-2.5-flare": "日常出图，速度优先",
    "gpt-image-2.5-sunburst": "画面创作，重视细节",
    "gpt-image-1.5": "通用绘图，贴合文字描述",
    "gpt-image-1-mini": "轻量绘图，成本优先",
  });

/** Unknown models have no invented capability claim or visible placeholder. */
export function modelDescription(id: string | null | undefined): string {
  return id && Object.hasOwn(MODEL_DESCRIPTIONS, id)
    ? MODEL_DESCRIPTIONS[id]
    : "";
}
