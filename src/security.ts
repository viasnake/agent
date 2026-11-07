import { createHash } from "node:crypto";
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const hash = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const byteHash = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export function safeRelative(path: string): string {
  if (
    !path ||
    path.length > 240 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((p) => !p || p === "." || p === "..") ||
    path.split("/").some((p) => [".ssh", ".aws", ".gnupg"].includes(p))
  )
    throw new AppError(400, "作業領域内の相対パスを指定してください");
  return path;
}
