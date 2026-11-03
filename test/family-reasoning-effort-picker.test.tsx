/** @jest-environment jsdom */
import { jest } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReasoningEffortPicker } from "../app/family/reasoning-effort-picker";

afterEach(cleanup);

test("offers the three strengths and delegates changes without retaining private local state", () => {
  const onChange = jest.fn();
  const view = render(
    <ReasoningEffortPicker value="low" onChange={onChange} />,
  );
  const picker = screen.getByRole("combobox", { name: "推理强度" });
  expect(picker).toHaveValue("low");
  expect(screen.getByRole("option", { name: "轻度" })).toHaveValue("low");
  expect(screen.getByRole("option", { name: "中等" })).toHaveValue("medium");
  expect(screen.getByRole("option", { name: "高强度" })).toHaveValue("high");
  fireEvent.change(picker, { target: { value: "high" } });
  expect(onChange).toHaveBeenCalledWith("high");
  view.rerender(<ReasoningEffortPicker value="medium" onChange={onChange} />);
  expect(picker).toHaveValue("medium");
  expect(screen.getByRole("combobox", { name: "推理强度" })).toBe(picker);
});

test("a locked picker cannot dispatch a strength change", () => {
  const onChange = jest.fn();
  render(<ReasoningEffortPicker value="low" onChange={onChange} disabled />);
  const picker = screen.getByRole("combobox", { name: "推理强度" });
  expect(picker).toBeDisabled();
  fireEvent.change(picker, { target: { value: "high" } });
  expect(onChange).not.toHaveBeenCalled();
});
