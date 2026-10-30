/** @jest-environment node */
import { jest } from "@jest/globals";
import { EventEmitter } from "node:events";

class FixtureWorker extends EventEmitter {
  static instances: FixtureWorker[] = [];
  static fail = false;
  terminate = jest.fn<() => Promise<number>>().mockResolvedValue(0);
  constructor(
    readonly code: string,
    readonly options: Record<string, any>,
  ) {
    super();
    if (FixtureWorker.fail) throw new Error("private module path");
    FixtureWorker.instances.push(this);
  }
}
jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("node:worker_threads", () => ({ Worker: FixtureWorker }));
const { inspectFamilyPdf } = await import("@/app/family/server/pdf-check");
const sample = Buffer.from("%PDF-1.7\nfixture");
beforeEach(() => {
  FixtureWorker.instances = [];
  FixtureWorker.fail = false;
});
afterEach(() => jest.useRealTimers());

test("fixed worker program receives bytes as data and terminates before success", async () => {
  const work = inspectFamilyPdf(sample);
  const worker = FixtureWorker.instances[0];
  expect(worker.code).not.toContain("fixture");
  expect(worker.options.eval).toBe(true);
  expect(worker.options.resourceLimits.maxOldGenerationSizeMb).toBe(64);
  expect(worker.options.resourceLimits.stackSizeMb).toBe(4);
  expect(worker.options.workerData.bytes).toEqual(new Uint8Array(sample));
  expect(worker.options.transferList).toHaveLength(1);
  worker.emit("message", { ok: true, pages: 2 });
  await expect(work).resolves.toEqual({ pages: 2 });
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(worker.listenerCount("message")).toBe(0);
  expect(worker.listenerCount("exit")).toBe(0);
});

test.each([Buffer.from("not a PDF"), Buffer.alloc(1_000_001)])(
  "rejects invalid or oversized input before creating a worker",
  async (bytes) => {
    await expect(inspectFamilyPdf(bytes)).rejects.toMatchObject({
      code: "ATTACHMENT_PDF_INVALID",
    });
    expect(FixtureWorker.instances).toHaveLength(0);
  },
);

test.each([
  { ok: false },
  { ok: true, pages: 0 },
  { ok: true, pages: "2" },
  null,
])("rejects malformed parser metadata and clears its worker", async (value) => {
  const work = inspectFamilyPdf(sample);
  const rejected = expect(work).rejects.toMatchObject({
    code: "ATTACHMENT_PDF_INVALID",
  });
  const worker = FixtureWorker.instances[0];
  worker.emit("message", value);
  await rejected;
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

test("ten-page limit rejects an otherwise completed parse", async () => {
  const work = inspectFamilyPdf(sample);
  const rejected = expect(work).rejects.toMatchObject({
    code: "ATTACHMENT_PDF_PAGE_LIMIT",
  });
  FixtureWorker.instances[0].emit("message", { ok: true, pages: 11 });
  await rejected;
  expect(FixtureWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
});

test("deadline stops a parser that never responds", async () => {
  jest.useFakeTimers();
  const work = inspectFamilyPdf(sample);
  const rejected = expect(work).rejects.toMatchObject({
    code: "ATTACHMENT_PDF_TIMEOUT",
  });
  await jest.advanceTimersByTimeAsync(2500);
  await rejected;
  expect(FixtureWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test("request abort stops the worker and removes the deadline", async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  const work = inspectFamilyPdf(sample, controller.signal);
  const rejected = expect(work).rejects.toMatchObject({
    code: "ATTACHMENT_CANCELLED",
  });
  controller.abort();
  await rejected;
  expect(FixtureWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test("already aborted request never launches a parser", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(inspectFamilyPdf(sample, controller.signal)).rejects.toMatchObject({
    code: "ATTACHMENT_CANCELLED",
  });
  expect(FixtureWorker.instances).toHaveLength(0);
});

test.each(["error", "exit"])(
  "worker %s becomes a safe error and is cleaned up",
  async (event) => {
    const work = inspectFamilyPdf(sample);
    const rejected = expect(work).rejects.toMatchObject({
      code: "ATTACHMENT_PDF_INVALID",
    });
    FixtureWorker.instances[0].emit(event, new Error("private parser data"));
    await rejected;
    expect(FixtureWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  },
);

test("worker startup failure does not expose a filesystem path", async () => {
  FixtureWorker.fail = true;
  await expect(inspectFamilyPdf(sample)).rejects.toMatchObject({
    code: "ATTACHMENT_PDF_INVALID",
    message: "PDF 无法读取，请使用未加密、内容完整的 PDF 文件。",
  });
});
