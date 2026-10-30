/** @jest-environment node */
import { jest } from "@jest/globals";
import { PDFDocument } from "pdf-lib";

jest.unstable_mockModule("server-only", () => ({}));
const { inspectFamilyPdf } = await import("@/app/family/server/pdf-check");

test("the real isolated parser accepts a small complete PDF", async () => {
  const document = await PDFDocument.create();
  document.addPage([240, 160]);
  await expect(inspectFamilyPdf(await document.save())).resolves.toEqual({
    pages: 1,
  });
}, 10000);

test("the real parser enforces the page limit", async () => {
  const document = await PDFDocument.create();
  for (let i = 0; i < 11; i++) document.addPage([240, 160]);
  await expect(inspectFamilyPdf(await document.save())).rejects.toMatchObject({
    code: "ATTACHMENT_PDF_PAGE_LIMIT",
  });
}, 10000);

test("the real parser rejects a truncated PDF without returning its error body", async () => {
  await expect(inspectFamilyPdf(Buffer.from("%PDF-1.7\ntruncated"))).rejects.toMatchObject({
    code: "ATTACHMENT_PDF_INVALID",
  });
}, 10000);
