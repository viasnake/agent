import type { WebSocket } from "@fastify/websocket";
import type { AgentService } from "./service.js";
import { AppError } from "./security.js";
import { terminalQueueBytes, terminalSize } from "./execution/terminal.js";
import type { TerminalIO } from "./execution/terminal.js";

export const terminalProtocol = "agent-terminal";

export function serveTerminal(
  socket: WebSocket,
  service: AgentService,
  sessionValid: () => boolean,
): void {
  const controller = new AbortController();
  let input: Parameters<TerminalIO["ready"]>[0] | undefined;
  let outputBytes = 0;
  let alive = true;
  const disconnect = () => {
    controller.abort();
    clearInterval(heartbeat);
    clearTimeout(deadline);
    clearTimeout(startup);
  };
  const close = (code: number) => {
    disconnect();
    if (socket.readyState === socket.OPEN) socket.close(code);
  };
  const heartbeat = setInterval(() => {
    if (!alive || !sessionValid() || !service.healthy()) {
      disconnect();
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, 15_000);
  const deadline = setTimeout(() => close(4001), 30 * 60_000);
  const startup = setTimeout(() => close(1011), 15_000);
  socket.on("pong", () => {
    alive = true;
  });
  socket.on("close", disconnect);
  socket.on("error", () => {
    disconnect();
    socket.terminate();
  });
  socket.on("message", (data, binary) => {
    if (controller.signal.aborted) return;
    if (!sessionValid() || !service.healthy()) return close(1008);
    if (!input || !Buffer.isBuffer(data)) return close(1008);
    try {
      if (binary) input(data);
      else input(terminalSize.parse(JSON.parse(data.toString("utf8"))));
    } catch {
      close(1008);
    }
  });
  const send = (data: string | Buffer) => {
    if (controller.signal.aborted) return;
    const size = Buffer.byteLength(data);
    outputBytes += size;
    if (
      outputBytes > 16 * 1024 * 1024 ||
      socket.bufferedAmount + size > terminalQueueBytes
    ) {
      close(4002);
      return;
    }
    socket.send(data, (error) => {
      if (error) close(1011);
    });
  };
  void service
    .terminal(
      {
        ready: (write) => {
          clearTimeout(startup);
          input = write;
          send("ready");
        },
        output: send,
      },
      controller.signal,
    )
    .then(
      () => close(1000),
      (error: unknown) =>
        close(
          error instanceof AppError && error.statusCode === 409 ? 4000 : 1011,
        ),
    );
}
