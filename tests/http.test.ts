import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, answer, call, until } from "./support.js";
import { createServer } from "../src/server.js";
const password = "synthetic-private-ui-password-1234567890";
test("real HTTP authentication, Host/Origin/CSRF, idempotent requests, attachments, output downloads and bounded pagination", async () => {
  const f = await fixture([
      call("write", { path: "outputs/file.txt", content: "result" }),
      answer("done"),
    ]),
    app = await createServer(f.service, password);
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
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers,
      payload: { requestId: randomUUID(), password },
    });
    assert.equal(login.statusCode, 200);
    headers.cookie = login.headers["set-cookie"]!.toString().split(";")[0]!;
    headers["x-csrf-token"] = login.json().csrf;
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
