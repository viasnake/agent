import { lstat, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { AppError } from "./security.js";

export class DeploymentGate {
  private active = 0;
  private held = false;

  get draining() {
    return this.held;
  }
  get idle() {
    return this.active === 0;
  }
  enter(): () => void {
    if (this.held)
      throw new AppError(
        503,
        "更新の準備中です。しばらくしてからやり直してください",
      );
    this.active++;
    return () => this.active--;
  }
  hold(): (() => void) | undefined {
    if (this.held) return;
    this.held = true;
    return () => {
      this.held = false;
    };
  }
}

// Private systemd runtime directory, inaccessible to the work UID and browser.
// A disconnected installer relinquishes admission unless it committed shutdown.
export async function listenForDeployment(
  path: string,
  gate: DeploymentGate,
  service: { healthy(): boolean; readonly busy: boolean },
  stop: () => void,
  waitMs = 60_000,
): Promise<() => void> {
  const previous = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (previous) {
    if (!previous.isSocket() || previous.uid !== process.getuid!())
      throw new Error("Unexpected deployment socket");
    await unlink(path);
  }
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (sockets.size >= 4) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let state: "command" | "waiting" | "ready" | "committed" = "command";
    let release: (() => void) | undefined;
    let poll: NodeJS.Timeout | undefined;
    let deadline = setTimeout(() => socket.destroy(), 5_000);
    let input = "";
    const cleanup = () => {
      sockets.delete(socket);
      clearTimeout(deadline);
      clearInterval(poll);
      if (state !== "committed") release?.();
    };
    const ready = () => {
      if (!gate.idle || service.busy) return;
      if (!service.healthy()) {
        socket.destroy();
      } else {
        clearInterval(poll);
        clearTimeout(deadline);
        state = "ready";
        deadline = setTimeout(() => socket.destroy(), 5_000);
        socket.write("drained\n");
      }
    };
    socket.once("close", cleanup);
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      input += chunk.toString("ascii");
      if (input.length > 32) return socket.destroy();
      if (!input.includes("\n")) return;
      const command = input;
      input = "";
      if (state === "command" && command === "ping 1\n" && service.healthy()) {
        socket.end("ready 1\n");
      } else if (
        state === "command" &&
        command === "drain 1\n" &&
        (release = gate.hold())
      ) {
        state = "waiting";
        clearTimeout(deadline);
        deadline = setTimeout(() => {
          clearInterval(poll);
          socket.end("timeout\n", () => socket.destroy());
        }, waitMs);
        poll = setInterval(ready, 100);
        ready();
      } else if (
        state === "ready" &&
        command === "stop\n" &&
        service.healthy() &&
        gate.idle &&
        !service.busy
      ) {
        state = "committed";
        clearTimeout(deadline);
        socket.once("close", stop);
        socket.end("stopping\n", () => socket.destroy());
      } else {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return () => {
    server.close();
    for (const socket of sockets) socket.destroy();
  };
}
