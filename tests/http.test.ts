import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, answer, call, until } from "./support.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("local endpoint configuration rejects public origins and work preview ports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-local-config-"));
  const path = join(directory, "config.yaml");
  async function config(origin: string, port = 8080) {
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        dataRoot: "/srv/agent-data",
        server: { origins: [origin], port },
      }),
    );
    return loadConfig(path);
  }
  try {
    for (const origin of [
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://[::1]:8080",
    ])
      assert.equal((await config(origin)).model, null);
    for (const origin of [
      "http://0.0.0.0:8080",
      "http://192.168.1.1:8080",
      "https://agent.example",
      "http://localhost:8080/path",
    ])
      await assert.rejects(config(origin));
    for (const port of [3000, 3999])
      await assert.rejects(
        config(`http://127.0.0.1:${port}`, port),
        /preview ports/,
      );
  } finally {
    await rm(directory, { recursive: true });
  }
});
test("local automatic session, Host/Origin/CSRF, idempotent requests, attachments, output downloads and bounded pagination", async () => {
  const f = await fixture([
      call("write", { path: "outputs/file.txt", content: "result" }),
      answer("done"),
    ]),
    app = await createServer(f.service);
  const origin = "http://127.0.0.1:8080",
    headers: Record<string, string> = { host: "127.0.0.1:8080", origin };
  try {
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/conversations", headers }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/conversations",
          headers: { ...headers, host: "evil.invalid" },
        })
      ).statusCode,
      403,
    );
    for (const remoteAddress of ["192.168.1.4", "203.0.113.1"]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/session",
        remoteAddress,
        headers: { ...headers, "x-forwarded-for": "127.0.0.1" },
      });
      assert.equal(
        response.statusCode,
        403,
        "Proxy headers cannot grant local access",
      );
    }
    for (const site of ["cross-site", "same-site"]) {
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: "/api/session",
            headers: { ...headers, "sec-fetch-site": site },
          })
        ).statusCode,
        403,
      );
    }
    const session = await app.inject({
      method: "GET",
      url: "/api/session",
      headers,
      remoteAddress: "10.0.2.2",
    });
    assert.equal(session.statusCode, 200);
    headers.cookie = session.headers["set-cookie"]!.toString().split(";")[0]!;
    headers["x-csrf-token"] = session.json().csrf;
    assert.match(headers.cookie!, /^agent_session=/);
    assert.match(
      session.headers["set-cookie"]!.toString(),
      /HttpOnly.*SameSite=Strict/i,
    );
    const again = await app.inject({
      method: "GET",
      url: "/api/session",
      headers,
    });
    assert.equal(again.json().csrf, session.json().csrf);
    assert.equal(again.headers["set-cookie"], undefined);
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/login", headers }))
        .statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/conversations",
          headers: { ...headers, origin: "https://evil.invalid" },
          payload: { requestId: randomUUID(), title: "attack" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/conversations",
          headers: { ...headers, "x-csrf-token": "bad" },
          payload: { requestId: randomUUID(), title: "attack" },
        })
      ).statusCode,
      403,
    );
    const { origin: _origin, ...withoutOrigin } = headers;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/conversations",
          headers: withoutOrigin,
          payload: { requestId: randomUUID(), title: "attack" },
        })
      ).statusCode,
      403,
    );
    const payload = { requestId: randomUUID(), title: "会話" };
    const created = await app.inject({
        method: "POST",
        url: "/api/conversations",
        headers,
        payload,
      }),
      id = created.json().id;
    assert.equal(created.statusCode, 201);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/conversations",
      headers,
      payload,
    });
    assert.equal(duplicate.json().id, id);
    const upload = await app.inject({
      method: "POST",
      url: `/api/conversations/${id}/uploads`,
      headers,
      payload: {
        requestId: randomUUID(),
        name: "test.csv",
        data: Buffer.from("a,b\n1,2\n").toString("base64"),
      },
    });
    assert.equal(upload.statusCode, 201);
    assert.match(upload.json().path, /attachments\//);
    const input = { requestId: randomUUID(), text: "create file" };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/conversations/${id}/messages`,
          headers,
          payload: input,
        })
      ).statusCode,
      202,
    );
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    const download = await app.inject({
      method: "GET",
      url: `/api/conversations/${id}/download?path=outputs%2Ffile.txt`,
      headers,
    });
    assert.equal(download.body, "result");
    assert.match(
      download.headers["content-disposition"]!.toString(),
      /^attachment/,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/conversations/${id}/download?path=..%2Fcontrol`,
          headers,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/conversations/${id}/messages`,
          headers,
          payload: { requestId: randomUUID(), text: "x".repeat(64001) },
        })
      ).statusCode,
      400,
    );
    assert.equal((await f.service.list()).length, 1);
  } finally {
    await app.close();
    await f.service.close();
  }
});
