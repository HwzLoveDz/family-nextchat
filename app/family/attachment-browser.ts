import type {
  FamilyAttachmentInput,
  FamilyAttachmentMeta,
  FamilyModel,
} from "./types";

export const ATTACHMENT_LIMITS = {
  count: 3,
  fileBytes: 1_000_000,
  totalBytes: 2_000_000,
  textBytes: 100 * 1024,
  textChars: 20_000,
  wireBytes: 3_000_000,
} as const;
export type PreparedAttachment = {
  file: File;
  kind: FamilyAttachmentMeta["kind"];
  width?: number;
  height?: number;
};
export function abortAttachment(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}
export function attachmentSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function safeAttachmentName(name: string) {
  return (
    name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/^\.+/, "")
      .trim()
      .slice(0, 120) || "附件"
  );
}

/** Read dimensions before decoding pixels; reject SVG/HEIC and oversized rasters. */
export function rasterDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    ) &&
    view.getUint32(8) === 13 &&
    String.fromCharCode(...bytes.subarray(12, 16)) === "IHDR"
  )
    return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset++] !== 255) continue;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 216 || marker === 1 || (marker >= 208 && marker <= 215))
        continue;
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2) return null;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker)
      )
        return {
          width: (bytes[offset + 5] << 8) | bytes[offset + 6],
          height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        };
      offset += length;
    }
  }
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const format = ascii(12, 4);
    if (format === "VP8X")
      return {
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      };
    if (format === "VP8 ")
      return {
        width: view.getUint16(26, true) & 16383,
        height: view.getUint16(28, true) & 16383,
      };
    if (format === "VP8L" && bytes[20] === 47)
      return {
        width: 1 + bytes[21] + ((bytes[22] & 63) << 8),
        height:
          1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10),
      };
  }
  return null;
}

async function normalizeImage(
  file: File,
  budget: number,
  signal: AbortSignal,
): Promise<PreparedAttachment> {
  if (file.size > 20_000_000)
    throw new Error("原始图片超过 20 MB，请先缩小后选择。");
  const dimensions = rasterDimensions(
    new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer()),
  );
  abortAttachment(signal);
  if (!dimensions || !dimensions.width || !dimensions.height)
    throw new Error("图片格式无法识别，仅支持 JPG、PNG 和 WebP。");
  if (
    dimensions.width * dimensions.height > 16_000_000 ||
    Math.max(dimensions.width, dimensions.height) > 12000
  )
    throw new Error("图片像素过大，请先缩小后选择。");
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        image.src = "";
        reject(new DOMException("Aborted", "AbortError"));
      };
      image.onload = () => {
        signal.removeEventListener("abort", cancel);
        resolve();
      };
      image.onerror = () => {
        signal.removeEventListener("abort", cancel);
        reject(new Error("图片无法打开，请重新选择。"));
      };
      signal.addEventListener("abort", cancel, { once: true });
      image.src = url;
      if (signal.aborted) cancel();
    });
    abortAttachment(signal);
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 16_000_000 ||
      Math.max(image.naturalWidth, image.naturalHeight) > 12000
    )
      throw new Error("图片像素过大或无法识别，请先缩小后选择。");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("此浏览器暂时无法处理图片，请重试。");
    const target = Math.min(900_000, budget);
    if (target < 10_000)
      throw new Error("附件合计超过 2 MB，请先移除部分附件。");
    let edge = Math.min(
      2048,
      Math.max(image.naturalWidth, image.naturalHeight),
    );
    for (let round = 0; round < 4; round++, edge = Math.floor(edge * 0.8)) {
      const scale = Math.min(
        1,
        edge / Math.max(image.naturalWidth, image.naturalHeight),
      );
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.86, 0.72, 0.58, 0.44]) {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", quality),
        );
        abortAttachment(signal);
        if (blob && blob.size <= target)
          return {
            file: new File(
              [blob],
              safeAttachmentName(file.name.replace(/\.[^.]+$/, "") + ".jpg"),
              { type: "image/jpeg", lastModified: file.lastModified },
            ),
            kind: "image",
            width: canvas.width,
            height: canvas.height,
          };
      }
    }
    throw new Error("图片缩小后仍超出限制，请选择更小的图片。");
  } finally {
    image.onload = null;
    image.onerror = null;
    image.src = "";
    URL.revokeObjectURL(url);
  }
}

export async function prepareAttachment(
  file: File,
  budget: number,
  signal: AbortSignal,
): Promise<PreparedAttachment> {
  abortAttachment(signal);
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (["heic", "heif"].includes(extension) || /image\/hei[cf]/i.test(file.type))
    throw new Error("暂不支持 HEIC/HEIF，请改选 JPG、PNG 或 WebP 图片。");
  if (
    ["jpg", "jpeg", "png", "webp"].includes(extension) ||
    ["image/jpeg", "image/png", "image/webp"].includes(file.type)
  )
    return normalizeImage(file, budget, signal);
  if (!file.size) throw new Error("附件为空，请重新选择。");
  if (file.size > ATTACHMENT_LIMITS.fileBytes || file.size > budget)
    throw new Error("附件超过单个 1 MB 或合计 2 MB 限制。");
  if (extension === "pdf") {
    const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    abortAttachment(signal);
    if (String.fromCharCode(...header) !== "%PDF-")
      throw new Error("PDF 格式无法识别，请重新选择。");
    return {
      file: new File([file], safeAttachmentName(file.name), {
        type: "application/pdf",
        lastModified: file.lastModified,
      }),
      kind: "pdf",
    };
  }
  const mediaTypes: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    log: "text/plain",
  };
  if (!mediaTypes[extension])
    throw new Error("支持 JPG/PNG/WebP、PDF，以及 txt/md/csv/json/log 文本。");
  if (file.size > ATTACHMENT_LIMITS.textBytes)
    throw new Error("文本附件最多 100 KiB。");
  const data = await file.arrayBuffer();
  abortAttachment(signal);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("文本不是有效的 UTF-8 编码，请转换后重试。");
  }
  if (text.length > ATTACHMENT_LIMITS.textChars || text.includes("\0"))
    throw new Error("文本最多 20,000 字符，且不能包含二进制内容。");
  return {
    file: new File([file], safeAttachmentName(file.name), {
      type: mediaTypes[extension],
      lastModified: file.lastModified,
    }),
    kind: "text",
  };
}

export async function encodeAttachmentInputs(
  items: readonly PreparedAttachment[],
  signal: AbortSignal,
): Promise<FamilyAttachmentInput[]> {
  if (
    items.length > 3 ||
    items.some((item) => item.file.size > 1_000_000) ||
    items.reduce((size, item) => size + item.file.size, 0) > 2_000_000
  )
    throw new Error("附件超出数量或大小限制，请移除部分附件。");
  const inputs: FamilyAttachmentInput[] = [];
  for (const item of items) {
    abortAttachment(signal);
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    abortAttachment(signal);
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 32768)
      chunks.push(
        String.fromCharCode(...bytes.subarray(offset, offset + 32768)),
      );
    inputs.push({
      name: item.file.name,
      mediaType: item.file.type,
      dataBase64: btoa(chunks.join("")),
    });
  }
  return inputs;
}
export function attachmentModelError(
  items: readonly Pick<PreparedAttachment, "kind">[],
  model?: FamilyModel,
): string {
  if (
    items.some((item) => item.kind === "image") &&
    model?.supportsImages === false
  )
    return "当前模型不支持图片，请切换支持图片的模型。";
  if (items.some((item) => item.kind === "pdf") && model?.supportsPdf === false)
    return "当前模型不支持 PDF，请切换支持 PDF 的模型。";
  return "";
}
