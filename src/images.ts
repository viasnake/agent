import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import type { Paths } from "./config.js";
import { AgentError, type DataClass, type ImageReference } from "./types.js";
import { atomicWrite, privateDirectory, sha256 } from "./util.js";

export const maxImageBytes = 5_000_000;
export const maxImageSide = 2048;
export const maxImagePixels = 4_194_304;
export const maxConversationImages = 8;
export const maxConversationImageBytes = 20_000_000;

const formats = {
  ".png": { format: "png", mimeType: "image/png" },
  ".jpg": { format: "jpeg", mimeType: "image/jpeg" },
  ".jpeg": { format: "jpeg", mimeType: "image/jpeg" },
  ".webp": { format: "webp", mimeType: "image/webp" },
} as const;

export type ValidatedImage = {
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
  editWidth: number;
  editHeight: number;
  sha256: string;
};

export async function validateImage(
  bytes: Buffer,
  expectedMimeType?: string,
): Promise<Omit<ValidatedImage, "bytes" | "sha256">> {
  if (!bytes.length || bytes.length > maxImageBytes)
    throw new AgentError(
      "IMAGE_SIZE",
      `Images must be at most ${maxImageBytes} bytes`,
    );
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
    throw new AgentError(
      "IMAGE_FORMAT",
      "Image extension, MIME type, and file signature must match PNG, JPEG, or WebP",
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
    throw new AgentError(
      "IMAGE_INVALID",
      "Image is malformed, truncated, animated, or cannot be fully decoded",
    );
  if (signature === "image/png" && hasApngAnimationControl(bytes))
    throw new AgentError(
      "IMAGE_DIMENSIONS",
      "Images must be static and at most 2048×2048 pixels",
    );
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
      throw new AgentError(
        "IMAGE_DIMENSIONS",
        `Images must be static and at most ${maxImageSide}×${maxImageSide} pixels`,
      );
    await sharp(bytes, options).raw().toBuffer();
    return {
      mimeType: signature,
      width: metadata.width,
      height: metadata.height,
      editWidth: [5, 6, 7, 8].includes(metadata.orientation ?? 0)
        ? metadata.height
        : metadata.width,
      editHeight: [5, 6, 7, 8].includes(metadata.orientation ?? 0)
        ? metadata.width
        : metadata.height,
    };
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError(
      "IMAGE_INVALID",
      "Image is malformed, truncated, animated, or cannot be fully decoded",
    );
  }
}

export function imageReference(
  name: string,
  validated: ValidatedImage,
  dataClass: DataClass,
  localOnly: boolean,
): ImageReference {
  return {
    id: `img-${validated.sha256}`,
    name: basename(name),
    mimeType: validated.mimeType,
    width: validated.width,
    height: validated.height,
    editWidth: validated.editWidth,
    editHeight: validated.editHeight,
    bytes: validated.bytes.length,
    sha256: validated.sha256,
    dataClass,
    localOnly,
  };
}

export function isImagePath(path: string): boolean {
  return Object.hasOwn(formats, extname(path).toLowerCase());
}

export function imageMimeForPath(path: string): string | undefined {
  return formats[extname(path).toLowerCase() as keyof typeof formats]?.mimeType;
}

export function isImageSignature(bytes: Buffer): boolean {
  return (
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (bytes[0] === 0xff && bytes[1] === 0xd8) ||
    (bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP")
  );
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

export async function isImageFileSignature(path: string): Promise<boolean> {
  const file = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1)
      throw new AgentError(
        "PATH_DENIED",
        "Links and special files are not accessible",
      );
    const prefix = Buffer.alloc(12);
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
    return isImageSignature(prefix.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

export async function readBoundedImage(path: string): Promise<Buffer> {
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const initial = await file.stat();
    if (
      !initial.isFile() ||
      initial.nlink !== 1 ||
      initial.size > maxImageBytes
    )
      throw new AgentError(
        "IMAGE_SIZE",
        `Image must be a regular file of at most ${maxImageBytes} bytes`,
      );
    const buffer = Buffer.alloc(maxImageBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const final = await file.stat();
    if (
      length !== initial.size ||
      length > maxImageBytes ||
      final.size !== initial.size ||
      final.ino !== initial.ino ||
      final.dev !== initial.dev ||
      final.mtimeMs !== initial.mtimeMs ||
      (process.getuid && final.uid !== process.getuid())
    )
      throw new AgentError("IMAGE_READ", "Image changed while it was read");
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}

export async function saveImage(
  paths: Paths,
  name: string,
  bytes: Buffer,
  dataClass: DataClass,
  localOnly: boolean,
): Promise<ImageReference> {
  const metadata = await validateImage(bytes, imageMimeForPath(name));
  const digest = sha256(bytes);
  const reference = imageReference(
    name,
    { ...metadata, bytes, sha256: digest },
    dataClass,
    localOnly,
  );
  const directory = join(paths.home, "images");
  await privateDirectory(directory);
  const target = join(directory, `${digest}.img`);
  const existing = await lstat(target).catch(() => undefined);
  if (!existing) await atomicWrite(target, bytes);
  else {
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1 ||
      (existing.mode & 0o777) !== 0o600 ||
      (process.getuid && existing.uid !== process.getuid()) ||
      existing.size !== bytes.length
    )
      throw new AgentError("IMAGE_STORAGE", "Image blob path is unsafe");
    const saved = await readBoundedImage(target);
    if (sha256(saved) !== digest)
      throw new AgentError("IMAGE_HASH", "Image blob integrity check failed");
  }
  return reference;
}

export async function transformImage(
  paths: Paths,
  source: ImageReference,
  operation: "crop" | "mask",
  bounds: { x: number; y: number; width: number; height: number },
): Promise<ImageReference> {
  for (const value of Object.values(bounds))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new AgentError(
        "IMAGE_BOUNDS",
        "Image bounds must be non-negative integers",
      );
  if (!bounds.width || !bounds.height)
    throw new AgentError(
      "IMAGE_BOUNDS",
      "Image crop or mask must have positive dimensions",
    );
  const bytes = await loadStoredImage(paths, source);
  try {
    const rotated = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: maxImagePixels,
    })
      .toColourspace("srgb")
      .rotate();
    const { data, info } = await rotated
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      bounds.x + bounds.width > info.width ||
      bounds.y + bounds.height > info.height
    )
      throw new AgentError(
        "IMAGE_BOUNDS",
        `Image bounds exceed the orientation-corrected ${info.width}×${info.height} image`,
      );
    let output: Buffer;
    if (operation === "crop") {
      output = await sharp(data, { raw: info })
        .extract({
          left: bounds.x,
          top: bounds.y,
          width: bounds.width,
          height: bounds.height,
        })
        .png({ compressionLevel: 9 })
        .toBuffer();
    } else {
      const masked = Buffer.from(data);
      for (let y = bounds.y; y < bounds.y + bounds.height; y++)
        for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
          const offset = (y * info.width + x) * info.channels;
          if (info.channels === 4) {
            masked.fill(0, offset, offset + 3);
            masked[offset + 3] = 255;
          } else if (info.channels === 3) masked.fill(0, offset, offset + 3);
          else masked[offset] = 0;
        }
      output = await sharp(masked, { raw: info })
        .png({ compressionLevel: 9 })
        .toBuffer();
    }
    const result = await saveImage(
      paths,
      `${source.name}-${operation}.png`,
      output,
      source.dataClass,
      source.localOnly,
    );
    return {
      ...result,
      sourceId: source.id,
      documentId: source.documentId,
      transformation: JSON.stringify({ type: operation, bounds }),
    };
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError("IMAGE_EDIT", "Image could not be transformed safely");
  }
}

export function validateImageReference(ref: ImageReference): void {
  if (
    !/^img-[a-f0-9]{64}$/.test(ref.id) ||
    ref.id !== `img-${ref.sha256}` ||
    !/^[a-f0-9]{64}$/.test(ref.sha256) ||
    !Number.isSafeInteger(ref.bytes) ||
    ref.bytes < 1 ||
    ref.bytes > maxImageBytes ||
    !Number.isSafeInteger(ref.width) ||
    !Number.isSafeInteger(ref.height) ||
    ref.width < 1 ||
    ref.height < 1 ||
    ref.width > maxImageSide ||
    ref.height > maxImageSide ||
    ref.width * ref.height > maxImagePixels ||
    !["image/png", "image/jpeg", "image/webp"].includes(ref.mimeType) ||
    !["public", "private", "restricted"].includes(ref.dataClass) ||
    typeof ref.localOnly !== "boolean"
  )
    throw new AgentError("IMAGE_REFERENCE", "Invalid stored image reference");
}

export async function loadStoredImage(
  paths: Paths,
  ref: ImageReference,
): Promise<Buffer> {
  validateImageReference(ref);
  const directory = join(paths.home, "images");
  const dirStat = await lstat(directory).catch(() => undefined);
  if (
    !dirStat?.isDirectory() ||
    dirStat.isSymbolicLink() ||
    (dirStat.mode & 0o777) !== 0o700 ||
    (process.getuid && dirStat.uid !== process.getuid())
  )
    throw new AgentError("IMAGE_STORAGE", "Image storage is unavailable");
  const path = join(directory, `${ref.sha256}.img`);
  const pathStat = await lstat(path).catch(() => undefined);
  if (
    !pathStat?.isFile() ||
    pathStat.isSymbolicLink() ||
    pathStat.nlink !== 1 ||
    (pathStat.mode & 0o777) !== 0o600 ||
    (process.getuid && pathStat.uid !== process.getuid()) ||
    pathStat.size !== ref.bytes
  )
    throw new AgentError("IMAGE_STORAGE", "Stored image is unavailable");
  const bytes = await readBoundedImage(path);
  if (sha256(bytes) !== ref.sha256)
    throw new AgentError("IMAGE_HASH", "Stored image integrity check failed");
  const metadata = await validateImage(bytes, ref.mimeType);
  if (metadata.width !== ref.width || metadata.height !== ref.height)
    throw new AgentError("IMAGE_METADATA", "Stored image metadata changed");
  return bytes;
}
