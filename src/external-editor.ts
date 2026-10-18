import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Paths } from "./config.js";
import { AgentError } from "./types.js";
import { atomicWrite, readText } from "./util.js";
import { cleanEnvironment } from "./process.js";

export async function editExternalText(
  paths: Paths,
  text: string,
  command: string[],
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (!command.length || command.some((arg) => !arg || arg.includes("\0")))
    throw new AgentError("EDITOR", "外部エディタの起動引数が不正です。");
  if (Buffer.byteLength(text) > maxBytes)
    throw new AgentError("INPUT_SIZE", "編集対象が入力上限を超えています。");
  const directory = await mkdtemp(join(paths.home, "editor-")),
    file = join(directory, "draft.md");
  try {
    await atomicWrite(file, text);
    const env: NodeJS.ProcessEnv = { ...cleanEnvironment };
    for (const key of [
      "HOME",
      "TERM",
      "LANG",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
      "XAUTHORITY",
    ])
      if (process.env[key]) env[key] = process.env[key];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command[0]!, [...command.slice(1), file], {
        cwd: directory,
        env,
        stdio: "inherit",
        shell: false,
      });
      let killTimer: NodeJS.Timeout | undefined;
      const abort = () => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
        killTimer.unref();
      };
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        if (killTimer) clearTimeout(killTimer);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.once("error", (error) => {
        cleanup();
        reject(
          Object.assign(
            new AgentError(
              "EDITOR",
              "外部エディタを起動できません。/editor-config で起動引数を確認してください。",
            ),
            { cause: error },
          ),
        );
      });
      child.once("close", (code) => {
        cleanup();
        if (signal.aborted)
          reject(new AgentError("CANCELLED", "外部編集を中止しました。"));
        else if (code !== 0)
          reject(
            new AgentError(
              "EDITOR",
              `外部エディタが終了コード ${code ?? "unknown"} を返しました。下書きは変更していません。`,
            ),
          );
        else resolve();
      });
    });
    signal.throwIfAborted();
    return await readText(file, maxBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
