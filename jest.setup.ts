// Learn more: https://github.com/testing-library/jest-dom
import "@testing-library/jest-dom";
import { jest } from "@jest/globals";

// Tests must opt in to synthetic provider credentials. Never inherit a local
// developer's secret pool into mocks, failed expectations or outbound requests.
function clearProviderTestCredentials() {
  for (const key of [
    "OPENAI_API_KEY",
    "FAMILY_OPENAI_PRIORITY_KEYS",
    "FAMILY_OPENAI_FALLBACK_NAME",
    "FAMILY_OPENAI_FALLBACK_ENABLED",
  ])
    delete process.env[key];
}
clearProviderTestCredentials();
beforeEach(clearProviderTestCredentials);

global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve([]),
    headers: new Headers(),
    redirected: false,
    statusText: "OK",
    type: "basic",
    url: "",
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    text: () => Promise.resolve(""),
  } as Response),
);
