import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DeploymentGate, listenForDeployment } from "../src/deploy.js";
import { createServer } from "../src/server.js";
import { answer, call, fixture, until } from "./support.js";
import { TerminalRunner } from "./terminal-fixture.js";

function connect(path: string, command: string) {
  const socket = createConnection(path);
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
  socket.write(command + "\n");
  return { socket, next: async () => (await lines.next()).value };
}

test(
  "deployment preserves an admitted command and an open terminal and rejects new work",
  { timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-deploy-"));
    const runner = new TerminalRunner(join(root, "work"));
    const f = await fixture(
      [
        call("bash", {
          command:
            "touch started; while [ ! -f finish ]; do sleep .05; done; echo completed",
        }),
        answer("completed before deployment"),
      ],
      { root, runner },
    );
    const gate = new DeploymentGate();
    const app = await createServer(f.service, undefined, gate);
    const path = join(root, "deploy.sock");
    let stopped!: () => void;
    const stopping = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const close = await listenForDeployment(path, gate, f.service, stopped);
    await app.ready();
    try {
      assert.equal(await connect(path, "ping 1").next(), "ready 1");
      const host = "127.0.0.1:8080";
      const origin = `http://${host}`;
      const session = await app.inject({
        url: "/api/session",
        headers: { host },
      });
      const csrf = session.json().csrf;
      const headers = {
        host,
        origin,
        cookie: `agent_session=${session.cookies[0]!.value}`,
        "x-csrf-token": csrf,
        "sec-websocket-protocol": `agent-terminal, csrf.${csrf}`,
      };
      const peer = new Socket();
      Object.defineProperty(peer, "remoteAddress", { value: "127.0.0.1" });
      const terminal = await app.injectWS("/api/terminal", {
        headers,
        socket: peer,
      });
      assert.equal((await once(terminal, "message"))[0].toString(), "ready");
      const conversation = await f.service.create(randomUUID(), "deployment");
      const send = () =>
        app.inject({
          method: "POST",
          url: `/api/conversations/${conversation.id}/messages`,
          headers,
          payload: { requestId: randomUUID(), text: "Run the command" },
        });
      assert.equal((await send()).statusCode, 202);
      const workspace = join(root, "work", "conversations", conversation.id);
      await until(async () =>
        access(join(workspace, "started")).then(
          () => true,
          () => false,
        ),
      );
      const deploy = connect(path, "drain 1");
      await until(async () => gate.draining);
      const blocked = await send();
      assert.equal(blocked.statusCode, 503);
      assert.match(blocked.body, /更新の準備中/);
      const rejected = await app.injectWS("/api/terminal", {
        headers,
        socket: peer,
      });
      assert.equal((await once(rejected, "close"))[0], 1013);
      assert.equal(runner.starts, 1);
      let drained = false;
      const notification = deploy.next().then((line) => {
        drained = true;
        return line;
      });
      await writeFile(join(workspace, "finish"), "");
      await until(
        async () =>
          (await f.service.conversation(conversation.id)).status === "idle",
      );
      assert.equal(
        drained,
        false,
        "the terminal must still keep the deployment waiting",
      );
      const closed = once(terminal, "close", {
        signal: AbortSignal.timeout(3000),
      });
      terminal.terminate();
      await closed;
      assert.equal(await notification, "drained");
      assert.match(
        JSON.stringify(await f.service.view(conversation.id)),
        /completed before deployment/,
      );
      assert.equal(
        (await send()).statusCode,
        503,
        "the admission gate stays held until shutdown",
      );
      deploy.socket.write("stop\n");
      assert.equal(await deploy.next(), "stopping");
      await stopping;
    } finally {
      close();
      await app.close();
      await f.service.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a deployment timeout or disconnect reopens admission without stopping", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-deploy-"));
  const gate = new DeploymentGate();
  const state = { healthy: () => true, busy: true };
  const path = join(root, "deploy.sock");
  const close = await listenForDeployment(
    path,
    gate,
    state,
    () => assert.fail("unexpected stop"),
    150,
  );
  try {
    const timedOut = connect(path, "drain 1");
    assert.equal(await timedOut.next(), "timeout");
    await until(async () => !gate.draining);
    gate.enter()();
    state.busy = false;
    const disconnected = connect(path, "drain 1");
    assert.equal(await disconnected.next(), "drained");
    disconnected.socket.destroy();
    await until(async () => !gate.draining);
    gate.enter()();
  } finally {
    close();
    await rm(root, { recursive: true, force: true });
  }
});
