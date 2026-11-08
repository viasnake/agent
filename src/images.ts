import sharp from "sharp";
import { extname } from "node:path";
import { AppError } from "./security.js";
const maxImageBytes = 5_000_000;
const maxImageSide = 2048;
const maxImagePixels = 4_194_304;
export const maxMessageImages = 8;
export const maxMessageImageBytes = 20_000_000;
const formats: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
export const imageMime = (path: string): string | undefined =>
  formats[extname(path).toLowerCase()];
export async function validateImage(
  bytes: Buffer,
  expectedMimeType?: string,
): Promise<{ mimeType: string }> {
  if (!bytes.length || bytes.length > maxImageBytes)
    throw new AppError(400, "画像は1枚5 MBまでです");
  const signature = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes[0] === 0xff && bytes[1] === 0xd8
      ? "image/jpeg"
      : bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
          bytes.subarray(8, 12).toString("ascii") === "WEBP"
        ? "image/webp"
        : undefined;
  if (!signature || (expectedMimeType && expectedMimeType !== signature))
    throw new AppError(
      400,
      "拡張子と形式が一致する PNG・JPEG・WebP の静止画像を指定してください",
    );
  const complete =
    signature === "image/png"
      ? bytes.length >= 12 &&
        bytes.subarray(bytes.length - 8, bytes.length - 4).toString("ascii") ===
          "IEND"
      : signature === "image/jpeg"
        ? bytes.length >= 2 &&
          bytes.subarray(bytes.length - 2).equals(Buffer.from([0xff, 0xd9]))
        : bytes.length >= 12 && bytes.readUInt32LE(4) + 8 === bytes.length;
  if (!complete)
    throw new AppError(
      400,
      "画像が破損しているか、静止画像として読み込めません",
    );
  if (signature === "image/png" && hasApngAnimationControl(bytes))
    throw new AppError(400, "画像は各辺2048px以下の静止画像にしてください");
  try {
    const options = {
      failOn: "warning" as const,
      limitInputPixels: maxImagePixels,
    };
    const metadata = await sharp(bytes, options).metadata();
    if (
      metadata.format !==
        ({ "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" }[
          signature
        ] as string) ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > maxImageSide ||
      metadata.height > maxImageSide ||
      metadata.width * metadata.height > maxImagePixels ||
      (metadata.pages ?? 1) !== 1
    )
      throw new AppError(400, "画像は各辺2048px以下の静止画像にしてください");
    await sharp(bytes, options).raw().toBuffer();
    return { mimeType: signature };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      400,
      "画像が破損しているか、静止画像として読み込めません",
    );
  }
}

function hasApngAnimationControl(bytes: Buffer): boolean {
  let offset = 8;
  const maxChunks = Math.ceil(maxImageBytes / 12);
  for (
    let index = 0;
    index < maxChunks && offset + 12 <= bytes.length;
    index++
  ) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IEND") return false;
    offset += length + 12;
  }
  return false;
}
