import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "../src/server.js";
import { fixture, until } from "./support.js";
import { TerminalRunner } from "./terminal-fixture.js";

test("terminal upgrade requires matching Host, Origin, browser session and CSRF before launching a PTY", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-terminal-http-"));
  const runner = new TerminalRunner(join(root, "work"));
  const f = await fixture([], { root, runner });
  const origin = f.config.server.origins[0]!;
  f.config.server.origins.push("http://localhost:8080");
  const app = await createServer(f.service);
  await app.ready();
  try {
    const host = new URL(origin).host;
    const session = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { host },
    });
    const cookie = session.cookies.find(
      (cookie) => cookie.name === "agent_session",
    )!;
    const headers = {
      host,
      origin,
      cookie: `agent_session=${cookie.value}`,
      "sec-fetch-site": "same-origin",
      "sec-websocket-protocol": `agent-terminal, csrf.${session.json().csrf}`,
    };
    const peer = new Socket();
    Object.defineProperty(peer, "remoteAddress", { value: "127.0.0.1" });
    for (const invalid of [
      { host: "evil.invalid" },
      { origin: "http://localhost:8080" },
      { origin: "" },
      { cookie: "" },
      { "sec-fetch-site": "cross-site" },
      { "sec-websocket-protocol": "agent-terminal, csrf.invalid" },
    ]) {
      await assert.rejects(
        app.injectWS("/api/terminal", {
          socket: peer,
          headers: { ...headers, ...invalid },
        }),
        /Unexpected server response: 40[13]/,
      );
    }
    assert.equal(runner.starts, 0);
    const target = await f.service.create(randomUUID(), "削除するセッション");
    const socket = await app.injectWS("/api/terminal", {
      socket: peer,
      headers,
    });
    const ready = await once(socket, "message", {
      signal: AbortSignal.timeout(6000),
    });
    assert.equal(ready[0].toString(), "ready");
    assert.equal(runner.starts, 1);
    await assert.rejects(f.service.deleteConversation(target.id), /ターミナル/);
    const other = await app.injectWS("/api/terminal", {
      socket: peer,
      headers,
    });
    assert.equal((await once(other, "close"))[0], 4000);
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ cols: 0, rows: 24 }));
    assert.equal((await closed)[0], 1008);
    await until(async () => !f.service.busy);
    assert.equal((await f.service.deleteConversation(target.id)).id, target.id);
  } finally {
    await app.close();
    await f.service.close();
    await rm(root, { recursive: true, force: true });
  }
});
