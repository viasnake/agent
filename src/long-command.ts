import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { CommandPreview, CommandProgress } from "./execution/protocol.js";
import { AppError } from "./security.js";

export type CommandState =
  | "running"
  | "exited"
  | "stopped"
  | "timed_out"
  | "failed";

export class LongCommand {
  readonly id = randomUUID();
  private readonly controller = new AbortController();
  private state: CommandState = "running";
  private output = "";
  private exitCode?: number;
  readonly finished: Promise<void>;

  constructor(
    run: (
      signal: AbortSignal,
      preview: CommandProgress,
    ) => Promise<ToolExecutionResult>,
    signal: AbortSignal,
    timeoutMs: number,
    redactPreview: (output: CommandPreview) => string,
    changed: () => void,
    cleanupFailed: (error: unknown) => boolean,
  ) {
    const deadline = AbortSignal.timeout(timeoutMs);
    const bounded = AbortSignal.any([signal, deadline, this.controller.signal]);
    this.finished = Promise.resolve().then(async () => {
      let result: ToolExecutionResult | undefined;
      let unconfirmed = false;
      try {
        bounded.throwIfAborted();
        result = await run(bounded, (output) => {
          if (bounded.aborted) return;
          this.output = redactPreview(output);
          changed();
        });
      } catch (error) {
        unconfirmed = cleanupFailed(error);
      }
      if (unconfirmed) {
        this.state = "failed";
      } else if (bounded.aborted) {
        this.state =
          deadline.aborted && bounded.reason === deadline.reason
            ? "timed_out"
            : "stopped";
      } else if (result) {
        const data = result.structuredOutput;
        this.exitCode =
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          typeof data.exitCode === "number"
            ? data.exitCode
            : undefined;
        this.state = this.exitCode === undefined ? "failed" : "exited";
      } else {
        this.state = "failed";
      }
      changed();
    });
  }

  get running() {
    return this.state === "running";
  }

  snapshot() {
    return {
      id: this.id,
      state: this.state,
      output: this.output,
      exitCode: this.exitCode,
    };
  }

  async wait(ms: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.running) return;
    let timer: NodeJS.Timeout | undefined;
    let cancel: () => void = () => {};
    const abort = new Promise<void>((_, reject) => {
      cancel = () => reject(signal?.reason);
      signal?.addEventListener("abort", cancel, { once: true });
    });
    try {
      await Promise.race([
        this.finished,
        abort,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }

  stop() {
    this.controller.abort();
    return this.finished;
  }
}

export function findCommand(current: LongCommand | undefined, id: string) {
  if (!current || current.id !== id)
    throw new AppError(404, "この実行中の応答にコマンドが見つかりません");
  return current;
}

// Redact in the raw window before selecting a display tail. The leading
// context stays hidden when output was dropped; it can start inside a secret.
export function redactCommandPreview(
  { text, truncated }: CommandPreview,
  knownSecrets: readonly string[],
) {
  const secrets = [...new Set(knownSecrets)].filter(Boolean);
  let overlap = 0;
  let leadingContext = 0;
  for (const secret of secrets) {
    leadingContext = Math.max(leadingContext, secret.length - 1);
    for (let n = Math.min(text.length, secret.length - 1); n > overlap; n--) {
      if (secret.startsWith(text.slice(-n))) {
        overlap = n;
        break;
      }
    }
  }
  const end = text.length - overlap;
  // A truncated first line may have lost an authorization header before the window.
  const newline = truncated ? text.indexOf("\n") : -1;
  if (truncated && newline < 0) return "";
  const start = Math.max(
    end - 8192,
    truncated ? Math.max(leadingContext, newline + 1) : 0,
  );
  if (start >= end) return "";
  const masked = new Uint8Array(end - start);
  for (const secret of secrets) {
    let offset = Math.max(0, start - secret.length + 1);
    while ((offset = text.indexOf(secret, offset)) >= 0 && offset < end) {
      masked.fill(
        1,
        Math.max(0, offset - start),
        Math.min(end, offset + secret.length) - start,
      );
      offset++;
    }
  }
  // Authorization and cookie lines are also sensitive when the value is not a configured secret.
  for (const match of text.matchAll(
    /(?:authorization|cookie)\s*[:=]\s*[^\r\n]+/gi,
  )) {
    const stop = Math.min(end, match.index + match[0].length);
    if (stop > start)
      masked.fill(1, Math.max(0, match.index - start), stop - start);
  }
  let output = "";
  for (let i = start; i < end; i++) {
    if (!masked[i - start]) output += text[i];
    else if (i === start || !masked[i - start - 1]) output += "[REDACTED]";
  }
  return output.slice(-8192);
}
