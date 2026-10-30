import "server-only";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { PDFDocument } from "pdf-lib";
import { FamilyApiError } from "./errors";

const PDF_MAX_BYTES = 1_000_000;
const PDF_MAX_PAGES = 10;
const PDF_CHECK_TIMEOUT_MS = 2_500;

// Only this fixed program is evaluated. Uploaded bytes are data, never code.
// Parsing stays outside the request thread; heap limits do not cover all native
// allocations, so the separate input-size and wall-clock bounds are essential.
const PDF_WORKER = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  try {
    const { PDFDocument } = require(workerData.modulePath);
    const document = await PDFDocument.load(workerData.bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    if (document.isEncrypted) throw new Error("encrypted");
    parentPort.postMessage({ ok: true, pages: document.getPageCount() });
  } catch {
    parentPort.postMessage({ ok: false });
  } finally {
    parentPort.close();
  }
})();
`;

function invalidPdf() {
  return new FamilyApiError(
    400,
    "PDF 无法读取，请使用未加密、内容完整的 PDF 文件。",
    "ATTACHMENT_PDF_INVALID",
  );
}

export async function inspectFamilyPdf(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<{ pages: number }> {
  if (
    bytes.byteLength < 8 ||
    bytes.byteLength > PDF_MAX_BYTES ||
    Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-"
  )
    throw invalidPdf();
  if (signal?.aborted)
    throw new FamilyApiError(400, "附件处理已取消。", "ATTACHMENT_CANCELLED");
  // This explicit dependency also makes Next trace the external package into the
  // server deployment. The worker resolves the same trusted installed module.
  if (typeof PDFDocument.load !== "function") throw invalidPdf();
  const modulePath = createRequire(join(process.cwd(), "package.json")).resolve(
    "pdf-lib",
  );
  const copy = Uint8Array.from(bytes);
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = async (error?: FamilyApiError, pages?: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (worker) {
        worker.removeAllListeners();
        worker.on("error", () => {});
        try {
          await worker.terminate();
        } catch {
          // Never expose a parser, worker, path or library error to the client.
        }
      }
      if (error) reject(error);
      else resolve({ pages: pages! });
    };
    const onAbort = () =>
      void finish(
        new FamilyApiError(400, "附件处理已取消。", "ATTACHMENT_CANCELLED"),
      );
    try {
      worker = new Worker(PDF_WORKER, {
        eval: true,
        workerData: { modulePath, bytes: copy },
        transferList: [copy.buffer],
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      });
      worker.once("message", (value: unknown) => {
        const message = value as { ok?: unknown; pages?: unknown } | null;
        if (
          !message ||
          message.ok !== true ||
          !Number.isSafeInteger(message.pages) ||
          (message.pages as number) < 1
        )
          return void finish(invalidPdf());
        if ((message.pages as number) > PDF_MAX_PAGES)
          return void finish(
            new FamilyApiError(
              400,
              "每份 PDF 最多 10 页，请拆分后再发送。",
              "ATTACHMENT_PDF_PAGE_LIMIT",
            ),
          );
        void finish(undefined, message.pages as number);
      });
      worker.once("error", () => void finish(invalidPdf()));
      worker.once("exit", () => {
        if (!settled) void finish(invalidPdf());
      });
      timer = setTimeout(
        () =>
          void finish(
            new FamilyApiError(
              400,
              "PDF 处理超时，请尝试更简单或更小的文件。",
              "ATTACHMENT_PDF_TIMEOUT",
            ),
          ),
        PDF_CHECK_TIMEOUT_MS,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    } catch {
      void finish(invalidPdf());
    }
  });
}
