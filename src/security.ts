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
export function publicUrl(value: string, preview = false): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new AppError(400, "HTTP(S) の公開 URL が必要です");
  const host = url.hostname.toLowerCase();
  if (
    preview &&
    ["127.0.0.1", "localhost"].includes(host) &&
    +url.port >= 3000 &&
    +url.port <= 3999
  )
    return url;
  if (
    host.includes(":") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".")
  )
    throw new AppError(403, "非公開の宛先は利用できません");
  if (/^\d+\./.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      a === 192 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      a! >= 224 ||
      (a === 198 && [18, 19, 51].includes(b!)) ||
      (a === 203 && b === 0)
    )
      throw new AppError(403, "非公開の宛先は利用できません");
  }
  return url;
}
export function publicRepo(value: string): string {
  const url = publicUrl(value);
  if (url.protocol !== "https:" || url.port || url.search)
    throw new AppError(400, "認証情報のない HTTPS Git URL が必要です");
  return url.href;
}
