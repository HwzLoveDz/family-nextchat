/** @jest-environment node */
import { jest } from "@jest/globals";
import fs from "fs/promises";

// A failed guard can only hit these mocks: no config files or child processes
// may be touched, including when a test intentionally enables legacy MCP.
const fsMock = {
  readFile: jest.fn(async () => JSON.stringify({ mcpServers: {} })),
  mkdir: jest.fn(async () => undefined),
  writeFile: jest.fn(async () => undefined),
};
const clientMock = {
  createClient: jest.fn(async () => {
    throw new Error("Unexpected child process request");
  }),
  executeRequest: jest.fn(async () => undefined),
  listTools: jest.fn(async () => ({ tools: [] })),
  removeClient: jest.fn(async () => undefined),
};
jest.unstable_mockModule("@/app/mcp/client", () => clientMock);
jest.unstable_mockModule("@/app/mcp/types", () => ({
  DEFAULT_MCP_CONFIG: { mcpServers: {} },
}));
// Next's Server Action transform can load its dependencies through CommonJS
// even under Jest's ESM runner. Cover that path too, rather than reading a real
// config file if the transform changes module format.
jest.mock("@/app/mcp/client", () => clientMock);
jest.mock("@/app/mcp/types", () => ({
  DEFAULT_MCP_CONFIG: { mcpServers: {} },
}));
const actions = await import("../app/mcp/actions");

const fixtureCode = "fixture-mcp-code-not-a-real-credential";
const actionCalls = [
  ["getClientsStatus", () => actions.getClientsStatus(fixtureCode)],
  ["getClientTools", () => actions.getClientTools("fixture", fixtureCode)],
  [
    "getAvailableClientsCount",
    () => actions.getAvailableClientsCount(fixtureCode),
  ],
  ["getAllTools", () => actions.getAllTools(fixtureCode)],
  ["initializeMcpSystem", () => actions.initializeMcpSystem(fixtureCode)],
  [
    "addMcpServer",
    () =>
      actions.addMcpServer(
        "fixture",
        { command: "fixture-command-never-executed", args: [] },
        fixtureCode,
      ),
  ],
  ["pauseMcpServer", () => actions.pauseMcpServer("fixture", fixtureCode)],
  ["resumeMcpServer", () => actions.resumeMcpServer("fixture", fixtureCode)],
  ["removeMcpServer", () => actions.removeMcpServer("fixture", fixtureCode)],
  ["restartAllClients", () => actions.restartAllClients(fixtureCode)],
  [
    "executeMcpAction",
    () =>
      actions.executeMcpAction(
        "fixture",
        { method: "tools/call", params: { name: "fixture" } },
        fixtureCode,
      ),
  ],
  ["getMcpConfigFromFile", () => actions.getMcpConfigFromFile(fixtureCode)],
] as const;

describe("MCP Server Action security boundary", () => {
  const original = Object.fromEntries(
    ["ENABLE_MCP", "CODE", "FAMILY_MODE", "NODE_ENV"].map((name) => [
      name,
      process.env[name],
    ]),
  );

  beforeEach(() => {
    Reflect.set(process.env, "NODE_ENV", "test");
    process.env.FAMILY_MODE = "0";
    process.env.ENABLE_MCP = "true";
    process.env.CODE = fixtureCode;
    jest.clearAllMocks();
    // The fs builtin can bypass ESM module mocks in Next's transform. Spy on
    // the actual shared methods before an action runs, so no real file access
    // is possible even if the guard regresses.
    jest
      .spyOn(fs, "readFile")
      .mockImplementation(fsMock.readFile as unknown as typeof fs.readFile);
    jest
      .spyOn(fs, "mkdir")
      .mockImplementation(fsMock.mkdir as unknown as typeof fs.mkdir);
    jest
      .spyOn(fs, "writeFile")
      .mockImplementation(fsMock.writeFile as unknown as typeof fs.writeFile);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else Reflect.set(process.env, name, value);
    }
  });

  function expectNoSideEffects() {
    for (const mock of [
      ...Object.values(fsMock),
      ...Object.values(clientMock),
    ]) {
      expect(mock).not.toHaveBeenCalled();
    }
  }

  test.each([
    ["test", "1"],
    ["production", "1"],
    ["production", "0"],
    ["production", undefined],
  ] as const)(
    "all actions stay disabled for NODE_ENV=%s FAMILY_MODE=%s despite valid legacy credentials",
    async (nodeEnv, mode) => {
      Reflect.set(process.env, "NODE_ENV", nodeEnv);
      if (mode === undefined) delete process.env.FAMILY_MODE;
      else process.env.FAMILY_MODE = mode;
      expect(await actions.isMcpEnabled()).toBe(false);
      for (const [_name, call] of actionCalls) {
        await expect(call()).rejects.toThrow("MCP is not enabled");
      }
      expectNoSideEffects();
    },
  );

  test("every exported action is represented in the direct-call boundary", () => {
    expect(Object.keys(actions).sort()).toEqual(
      [...actionCalls.map(([name]) => name), "isMcpEnabled"].sort(),
    );
  });

  test("process-capable client functions are replaced by the test fence", async () => {
    const client = await import("../app/mcp/client");
    expect(client.createClient).toBe(clientMock.createClient);
    expect(client.executeRequest).toBe(clientMock.executeRequest);
    expectNoSideEffects();
  });

  test("legacy development still requires an explicit MCP feature flag", async () => {
    delete process.env.ENABLE_MCP;
    expect(await actions.isMcpEnabled()).toBe(false);
    for (const [_name, call] of actionCalls) {
      await expect(call()).rejects.toThrow("MCP is not enabled");
    }
    expectNoSideEffects();
  });

  test("legacy development with valid code can read only the mocked config", async () => {
    expect(await actions.isMcpEnabled()).toBe(true);
    await expect(actions.getMcpConfigFromFile(fixtureCode)).resolves.toEqual({
      mcpServers: {},
    });
    expect(fsMock.readFile).toHaveBeenCalledTimes(1);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(clientMock.createClient).not.toHaveBeenCalled();
  });

  test("legacy development rejects an incorrect code before filesystem/process access", async () => {
    await expect(
      actions.getMcpConfigFromFile("wrong-fixture-code"),
    ).rejects.toThrow("Unauthorized MCP request");
    expectNoSideEffects();
  });

  test("legacy development without CODE fails closed", async () => {
    delete process.env.CODE;
    await expect(actions.getMcpConfigFromFile("")).rejects.toThrow(
      "MCP requires CODE to be configured",
    );
    expectNoSideEffects();
  });
});
