import { fireEvent, within } from "@testing-library/react";

/** Exercise the same open-and-choose flow as pointer and touch users. */
export function chooseWorkspaceOption(control: HTMLElement, value: unknown) {
  if (control instanceof HTMLSelectElement) {
    fireEvent.change(control, { target: { value } });
    return;
  }
  if (control.hasAttribute("disabled")) {
    fireEvent.click(control);
    return;
  }
  if (control.getAttribute("aria-expanded") !== "true") {
    fireEvent.pointerDown(control);
    control.focus();
    fireEvent.click(control);
  }
  const listId = control.getAttribute("aria-controls");
  const list = listId && document.getElementById(listId);
  if (!list) throw new Error("The choice popup did not open");
  const option = within(list)
    .getAllByRole("option")
    .find((item) => item.getAttribute("data-value") === String(value));
  if (!option) throw new Error(`No choice is available for ${String(value)}`);
  fireEvent.click(option);
}
