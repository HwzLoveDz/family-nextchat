/** @jest-environment node */
import {
  MODEL_DESCRIPTIONS,
  modelDescription,
} from "../app/family/model-descriptions";

test("every current text/image model has a short plain-text selection description", () => {
  const ids = [
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
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
    "gpt-image-1.5",
    "gpt-image-1-mini",
  ];
  expect(Object.keys(MODEL_DESCRIPTIONS).sort()).toEqual(ids.sort());
  for (const id of ids) {
    const description = modelDescription(id);
    expect(description).toMatch(/[\u4e00-\u9fff]/);
    expect([...description].length).toBeLessThanOrEqual(20);
    expect(description).not.toMatch(/[<>\r\n]|https?:|最强|最快|实时联网/);
  }
  expect(Object.isFrozen(MODEL_DESCRIPTIONS)).toBe(true);
});

test("unknown, missing and inherited names stay empty instead of claiming a model capability", () => {
  for (const id of [
    null,
    undefined,
    "",
    "unknown-model",
    "gpt-6-astra-custom",
    "gpt-image-2.5-sunburst-experimental",
    "constructor",
    "__proto__",
    "toString",
  ])
    expect(modelDescription(id)).toBe("");
});

test("descriptions distinguish chat reasoning, faster drawing and economical drawing without promising unavailable tools", () => {
  expect(modelDescription("gpt-6.1-sol")).toContain("推理");
  expect(modelDescription("gpt-image-2.5-flare")).toContain("速度");
  expect(modelDescription("gpt-image-1-mini")).toContain("成本");
  expect(Object.values(MODEL_DESCRIPTIONS).join(" ")).not.toMatch(
    /联网|搜索|修图|编辑图片|操控电脑|无限|免费/,
  );
});
