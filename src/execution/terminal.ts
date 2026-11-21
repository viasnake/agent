import { z } from "zod";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export const terminalFrameBytes = 64 * 1024;
export const terminalQueueBytes = 256 * 1024;
export const terminalSize = z
  .object({
    cols: z.number().int().min(2).max(512),
    rows: z.number().int().min(1).max(256),
  })
  .strict();

type TerminalInput = Buffer | z.infer<typeof terminalSize>;
export type TerminalIO = {
  ready: (input: (value: TerminalInput) => void) => void;
  output: (bytes: Buffer) => void;
};

// A nonzero length precedes key bytes. Zero precedes the new columns and rows.
function terminalFrame(input: TerminalInput): Buffer {
  if (Buffer.isBuffer(input)) {
    if (!input.length || input.length > terminalFrameBytes)
      throw new Error("Invalid terminal input size");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(input.length);
    return Buffer.concat([header, input]);
  }
  const { cols, rows } = terminalSize.parse(input);
  const frame = Buffer.alloc(8);
  frame.writeUInt16BE(cols, 4);
  frame.writeUInt16BE(rows, 6);
  return frame;
}

export async function relayWorkerTerminal(
  child: ChildProcessWithoutNullStreams,
  io: TerminalIO,
): Promise<void> {
  let ready = false;
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (data: Buffer) => {
      try {
        if (!ready) {
          if (data[0] !== 0) throw new Error("Invalid terminal startup");
          ready = true;
          io.ready((input) => {
            const frame = terminalFrame(input);
            if (
              child.stdin.writableEnded ||
              child.stdin.destroyed ||
              child.stdin.writableLength + frame.length > terminalQueueBytes
            )
              throw new Error("Terminal input is unavailable");
            child.stdin.write(frame);
          });
          data = data.subarray(1);
        }
        if (data.length) io.output(data);
      } catch (error) {
        reject(error);
      }
    });
    child.once("error", reject);
    child.stdin.once("error", reject);
    child.once("close", (code) => {
      if (ready && code === 0) resolve();
      else reject(new Error("Worker terminal ended"));
    });
    child.stdin.write('{"type":"terminal"}\n', (error) => {
      if (error) reject(error);
    });
  });
}
