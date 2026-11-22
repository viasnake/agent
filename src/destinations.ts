import { execFile } from "node:child_process";
import { z } from "zod";
import { AppError } from "./security.js";

const entries = z
  .array(
    z
      .object({
        name: z.string().max(160),
        ip: z.ipv4(),
        port: z.number().int().min(1).max(65535),
      })
      .strict(),
  )
  .max(64);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const destinationUpdate = z.object({ revision, entries }).strict();
const snapshot = destinationUpdate.extend({
  status: z.literal("ok"),
  applied: z.boolean(),
});
export type Destination = z.infer<typeof entries>[number];
export type DestinationSettings = z.infer<typeof snapshot>;

export async function destinationSettings(
  update?: z.infer<typeof destinationUpdate>,
): Promise<DestinationSettings> {
  const request = update
    ? { operation: "write", ...update }
    : { operation: "read" };
  const untrusted = await new Promise<unknown>((resolve, reject) => {
    const unavailable = () =>
      new AppError(
        503,
        "接続先の許可を確認または反映できません。再読み込みしてください",
      );
    const child = execFile(
      "/usr/bin/sudo",
      ["-n", "-u", "root", "--", "/usr/local/libexec/agent-destinations"],
      {
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 128 * 1024,
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      },
      (error, stdout) => {
        if (error) return reject(unavailable());
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(unavailable());
        }
      },
    );
    child.stdin?.on("error", () => reject(unavailable()));
    child.stdin?.end(JSON.stringify(request));
  });
  const result = snapshot.safeParse(untrusted);
  if (result.success) return result.data;
  const state = z.object({ status: z.string() }).safeParse(untrusted);
  if (state.data?.status === "conflict")
    throw new AppError(409, "別の画面で変更されました。再読み込みしてください");
  if (state.data?.status === "invalid")
    throw new AppError(
      400,
      "予約・保護アドレス、重複した接続先、または無効な名前は登録できません",
    );
  throw new AppError(503, "このホストでは接続先の許可を利用できません");
}
