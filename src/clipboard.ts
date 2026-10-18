import { spawn } from "node:child_process";
import { AgentError } from "./types.js";
import { maxImageBytes } from "./images.js";

export async function readClipboardPng(
  platform = process.platform,
): Promise<Buffer> {
  const adapters: Array<[string, string[]]> =
    platform === "linux"
      ? [
          ["wl-paste", ["--no-newline", "--type", "image/png"]],
          ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
        ]
      : platform === "darwin"
        ? [["pngpaste", ["-"]]]
        : [];
  for (const [command, args] of adapters) {
    try {
      return await readAdapter(command, args);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ETOOBIG") throw error;
    }
  }
  const remote = process.env.SSH_CONNECTION || process.env.SSH_TTY;
  throw new AgentError(
    "CLIPBOARD_UNAVAILABLE",
    `Clipboard PNG capture is unavailable. Save the image as a PNG and attach it with @path.${remote ? " For SSH, use scp or sftp to place it in the workspace, then attach it by path." : ""}`,
  );
}

function readAdapter(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let length = 0,
      settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, length));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        Object.assign(new Error("Clipboard adapter timed out"), {
          code: "ETIMEDOUT",
        }),
      );
    }, 5000);
    child.on("error", (error) => finish(error));
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > maxImageBytes) {
        child.kill("SIGKILL");
        finish(
          Object.assign(new Error("Clipboard image exceeds the size limit"), {
            code: "ETOOBIG",
          }),
        );
      } else chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0 || !length)
        finish(
          Object.assign(new Error("Clipboard has no PNG image"), { code }),
        );
      else finish();
    });
  });
}
