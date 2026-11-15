import { z } from "zod";
import { AppError } from "./security.js";

// These variables belong to the fixed launcher, not to configured work credentials.
const reserved = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONHOME",
  "PYTHONPATH",
]);
export const environmentName = z
  .string()
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine(
    (name) =>
      !reserved.has(name) &&
      !name.startsWith("LD_") &&
      !name.startsWith("SUDO_"),
    "Application-managed environment variable",
  );
export const workEnvironment = z
  .record(
    environmentName,
    z
      .string()
      .max(16384)
      .refine((v) => !v.includes("\0")),
  )
  .refine(
    (env) =>
      Object.keys(env).length <= 100 && JSON.stringify(env).length <= 65536,
    "Environment is too large",
  );
export const workCredentialInput = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.string().uuid(),
      name: z.string().trim().min(1).max(100),
      kind: z.literal("env"),
      env: workEnvironment.optional(),
      envKeep: z.array(environmentName).max(100).optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      name: z.string().trim().min(1).max(100),
      kind: z.literal("ssh"),
      privateKey: z.string().min(1).max(16384).optional(),
      generateKey: z.literal(true).optional(),
    })
    .strict(),
]);
export type WorkCredentialInput = z.infer<typeof workCredentialInput>;
export type WorkCredential =
  | { id: string; name: string; kind: "env"; env: Record<string, string> }
  | {
      id: string;
      name: string;
      kind: "ssh";
      privateKey: string;
      publicKey: string;
    };
export function sharedCredentials(credentials: WorkCredential[]) {
  const env: Record<string, string> = Object.create(null);
  const keys: string[] = [];
  for (const credential of credentials) {
    if (credential.kind === "ssh") keys.push(credential.privateKey);
    else
      for (const [name, value] of Object.entries(credential.env)) {
        if (Object.hasOwn(env, name))
          throw new AppError(409, "クレデンシャルの環境変数名が重複しています");
        env[name] = value;
      }
  }
  return { env: workEnvironment.parse(env), keys };
}
