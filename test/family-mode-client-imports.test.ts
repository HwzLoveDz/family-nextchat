/** @jest-environment jsdom */
import { jest } from "@jest/globals";

// Client-shared mode checks must remain usable without Next's server runtime or
// a Request polyfill. An accidental import now fails at the module boundary.
jest.unstable_mockModule("next/server", () => {
  throw new Error("Shared family-mode utilities must not import next/server");
});

test("pure mode/header helpers import without the server response factory", async () => {
  const requestDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Request",
  );
  Reflect.deleteProperty(globalThis, "Request");
  try {
    const helper = await import("../app/family/enabled");
    expect(typeof helper.isFamilyMode).toBe("function");
    expect(helper.PRIVATE_API_HEADERS["Cache-Control"]).toContain("no-store");
    expect(Object.keys(helper).sort()).toEqual([
      "PRIVATE_API_HEADERS",
      "isFamilyMode",
    ]);
  } finally {
    if (requestDescriptor)
      Object.defineProperty(globalThis, "Request", requestDescriptor);
    else Reflect.deleteProperty(globalThis, "Request");
  }
});
