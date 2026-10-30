import "server-only";
import type { FamilyModel, FamilyModelCatalog } from "../types";
import { FamilyApiError } from "./errors";

// Only text Chat Completions profiles explicitly checked against OpenAI's model
// pages are admitted. An account's /models list is not a capability declaration.
// https://developers.openai.com/api/docs/guides/latest-model
// https://developers.openai.com/api/docs/models/gpt-5-mini
// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
const PROFILES: Record<string, Omit<FamilyModel, "id">> = {
  "gpt-4o-mini": {
    name: "GPT-4o mini",
    description: "轻快的日常聊天",
    reasoning: false,
  },
  "gpt-4o": { name: "GPT-4o", description: "通用聊天与写作", reasoning: false },
  "gpt-4.1-nano": {
    name: "GPT-4.1 nano",
    description: "简短问答与轻量任务",
    reasoning: false,
  },
  "gpt-4.1-mini": {
    name: "GPT-4.1 mini",
    description: "日常问答与文字处理",
    reasoning: false,
  },
  "gpt-4.1": {
    name: "GPT-4.1",
    description: "复杂文字与代码任务",
    reasoning: false,
  },
  "gpt-5-nano": {
    name: "GPT-5 nano",
    description: "轻量推理与问答",
    reasoning: true,
  },
  "gpt-5-mini": {
    name: "GPT-5 mini",
    description: "日常任务与推理",
    reasoning: true,
  },
  "gpt-5": { name: "GPT-5", description: "复杂问题与推理", reasoning: true },
  "gpt-5.1": {
    name: "GPT-5.1",
    description: "通用推理与写作",
    reasoning: true,
  },
  "gpt-5.2": {
    name: "GPT-5.2",
    description: "复杂任务与推理",
    reasoning: true,
  },
  "gpt-5.4": {
    name: "GPT-5.4",
    description: "复杂任务与推理",
    reasoning: true,
  },
  "gpt-5.4-mini": {
    name: "GPT-5.4 mini",
    description: "日常聊天与推理",
    reasoning: true,
  },
  "gpt-5.4-nano": {
    name: "GPT-5.4 nano",
    description: "轻量聊天与推理",
    reasoning: true,
  },
  "gpt-6-astra": {
    name: "GPT-6 Astra",
    description: "复杂问题推理",
    reasoning: true,
  },
  "gpt-6.1-sol": {
    name: "GPT-6.1 Sol",
    description: "通用聊天与推理",
    reasoning: true,
  },
  "gpt-6.1-terra": {
    name: "GPT-6.1 Terra",
    description: "通用聊天与推理",
    reasoning: true,
  },
  "gpt-6-sol": {
    name: "GPT-6 Sol",
    description: "通用聊天与推理",
    reasoning: true,
  },
  "gpt-6-luna": {
    name: "GPT-6 Luna",
    description: "轻快聊天与推理",
    reasoning: true,
  },
};
const DEFAULT_MODELS = [
  "gpt-4o-mini",
  "gpt-4.1-nano",
  "gpt-4.1-mini",
  "gpt-4.1",
  "gpt-4o",
  "gpt-5.4-mini",
  "gpt-6-luna",
  "gpt-6.1-terra",
  "gpt-6.1-sol",
  "gpt-6-astra",
];

export function modelCatalog(): FamilyModelCatalog {
  const defaultModel = process.env.FAMILY_OPENAI_MODEL?.trim() || "gpt-4o-mini";
  const raw = process.env.FAMILY_OPENAI_MODELS;
  const ids =
    raw === undefined
      ? [...new Set([defaultModel, ...DEFAULT_MODELS])]
      : [
          ...new Set(
            raw
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean),
          ),
        ];
  if (
    !ids.length ||
    ids.length > 20 ||
    !ids.includes(defaultModel) ||
    ids.some((id) => !Object.hasOwn(PROFILES, id))
  )
    throw new FamilyApiError(
      503,
      "模型目录尚未配置完成，请联系管理员。",
      "MODEL_CATALOG_MISCONFIGURED",
    );
  return { defaultModel, models: ids.map((id) => ({ id, ...PROFILES[id] })) };
}

export function allowedModel(value: unknown): FamilyModel {
  if (typeof value !== "string" || !value || value.length > 100)
    throw new FamilyApiError(400, "请选择列表中的模型。", "MODEL_NOT_ALLOWED");
  const model = modelCatalog().models.find((model) => model.id === value);
  if (!model)
    throw new FamilyApiError(
      400,
      "此模型当前不可选，请刷新模型列表。",
      "MODEL_NOT_ALLOWED",
    );
  return model;
}

export function completionBody(
  model: FamilyModel,
  messages: { role: "user" | "assistant"; content: string }[],
) {
  return {
    model: model.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 2048,
    ...(model.reasoning ? { reasoning_effort: "low" } : {}),
    // Sampling parameters are deliberately omitted: reasoning profiles reject
    // temperature/top_p in several supported modes. No client tuning is accepted.
  };
}
