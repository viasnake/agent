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
  async function config(origin: string, port = 8080, host?: string) {
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        dataRoot: "/mnt/persistent/agent",
        server: { origins: [origin], port, host },
      }),
    );
    return loadConfig(path);
  }
  try {
    const standalone = await config("http://localhost:8080");
    assert.equal(standalone.dataRoot, "/mnt/persistent/agent");
    assert.equal(standalone.server.host, "0.0.0.0");
    assert.equal(
      (await config("http://localhost:8080", 8080, "127.0.0.1")).server.host,
      "127.0.0.1",
      "An explicit existing listen address is preserved",
    );
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
    const attachment = await app.inject({
      method: "GET",
      url: `/api/conversations/${id}/download?path=${encodeURIComponent(upload.json().path)}`,
      headers,
    });
    assert.equal(attachment.statusCode, 200);
    assert.equal(attachment.body, "a,b\n1,2\n");
    assert.match(
      attachment.headers["content-disposition"]!.toString(),
      /filename\*=UTF-8''test.csv$/,
    );
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
    const sessionUrl = `/api/conversations/${id}`;
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: sessionUrl,
          headers: { ...headers, "x-csrf-token": "bad" },
          payload: { title: "blocked" },
        })
      ).statusCode,
      403,
    );
    for (const invalid of [{ title: " " }, {}, { model: "unsupported" }])
      assert.equal(
        (
          await app.inject({
            method: "PATCH",
            url: sessionUrl,
            headers,
            payload: invalid,
          })
        ).statusCode,
        400,
      );
    const renamed = await app.inject({
      method: "PATCH",
      url: sessionUrl,
      headers,
      payload: { title: "  保存する会話  ", pinned: true, archived: true },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().title, "保存する会話");
    assert.equal(renamed.json().pinned, true);
    assert.equal(renamed.json().archived, true);
    const search = await app.inject({
      url: sessionUrl + "/search?q=create",
      headers,
    });
    assert.equal(search.statusCode, 200);
    assert.equal(search.json().matches.length, 1);
    const exported = await app.inject({ url: sessionUrl + "/export", headers });
    assert.equal(exported.statusCode, 200);
    assert.match(
      exported.headers["content-disposition"]!.toString(),
      /^attachment/,
    );
    assert.match(exported.body, /create file/);
    assert.match(exported.body, /保存する会話/);
    for (const deniedHeaders of [
      { ...headers, "x-csrf-token": "bad" },
      { ...headers, origin: "https://evil.invalid" },
    ])
      assert.equal(
        (
          await app.inject({
            method: "DELETE",
            url: sessionUrl,
            headers: deniedHeaders,
          })
        ).statusCode,
        403,
      );
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: sessionUrl,
          headers: { host: headers.host!, origin },
        })
      ).statusCode,
      401,
    );
    assert.equal((await f.service.list()).length, 1);
    for (let retry = 0; retry < 2; retry++)
      assert.equal(
        (await app.inject({ method: "DELETE", url: sessionUrl, headers }))
          .statusCode,
        200,
      );
    for (const suffix of [
      "",
      "/files",
      "/search?q=create",
      "/export",
      "/download?path=outputs%2Ffile.txt",
      "/events",
      "/images?entry=1&message=0&block=0",
    ])
      assert.equal(
        (await app.inject({ url: sessionUrl + suffix, headers })).statusCode,
        404,
      );
    assert.deepEqual(
      (await app.inject({ url: "/api/conversations", headers })).json()
        .conversations,
      [],
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/conversations",
          headers,
          payload,
        })
      ).statusCode,
      410,
    );
  } finally {
    await app.close();
    await f.service.close();
  }
});

test("VM forwarding accepts socket peers without registration and preserves browser protections", async () => {
  const f = await fixture();
  f.config.server.host = "0.0.0.0";
  const app = await createServer(f.service);
  try {
    await app.listen({ host: f.config.server.host, port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    assert.equal(address.address, "0.0.0.0");
    const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    const headers = { host: "127.0.0.1:8080", origin: "http://127.0.0.1:8080" };
    for (const remoteAddress of [
      "10.0.2.2",
      "::ffff:10.0.2.2",
      "192.168.64.1",
      "203.0.113.1",
    ])
      assert.equal(
        (
          await app.inject({
            url: "/api/session",
            headers,
            remoteAddress,
          })
        ).statusCode,
        200,
      );
    assert.equal(
      (
        await app.inject({
          url: "/api/session",
          headers: {
            ...headers,
            host: "evil.invalid",
            "x-forwarded-host": headers.host,
            "x-forwarded-for": "127.0.0.1",
          },
          remoteAddress: "10.0.2.2",
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/session",
          headers: { ...headers, origin: "https://evil.invalid" },
          remoteAddress: "10.0.2.2",
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/session",
          headers: { ...headers, "sec-fetch-site": "cross-site" },
          remoteAddress: "10.0.2.2",
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/conversations",
          method: "POST",
          payload: { requestId: randomUUID(), title: "blocked" },
          headers,
          remoteAddress: "10.0.2.2",
        })
      ).statusCode,
      401,
    );
    const session = await app.inject({
      url: "/api/session",
      headers,
      remoteAddress: "10.0.2.2",
    });
    const cookie = session.headers["set-cookie"]!.toString().split(";")[0]!;
    const payload = { requestId: randomUUID(), title: "forwarded session" };
    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/conversations",
      headers: { ...headers, cookie },
      payload,
      remoteAddress: "10.0.2.2",
    });
    assert.equal(missingCsrf.statusCode, 403);
    const created = await app.inject({
      method: "POST",
      url: "/api/conversations",
      headers: { ...headers, cookie, "x-csrf-token": session.json().csrf },
      payload,
      remoteAddress: "10.0.2.2",
    });
    assert.equal(created.statusCode, 201);
  } finally {
    await app.close();
    await f.service.close();
  }
});
