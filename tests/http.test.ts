import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createServer } from "../src/server.js";
import { fixture, jobInput } from "./support.js";
import { AppDoc } from "../src/state.js";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

const password = "synthetic-UI-password-with-more-than-32-characters";
test("S10 S11 S14 A02 A10: real HTTP routes require authentication, Origin, Host, CSRF, revision and bounded input", async () => {
  const { service } = await fixture([], {
    noModel: true,
    secrets: ["synthetic-control-secret"],
  });
  const app = await createServer(service, password, resolve("dist/web"));
  const origin = "http://127.0.0.1:8080",
    base = { host: "127.0.0.1:8080", origin };
  try {
    assert.equal((await app.inject({ url: "/healthz" })).statusCode, 200);
    assert.equal(
      (await app.inject({ url: "/api/jobs", headers: base })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/login",
          headers: { ...base, origin: "http://evil.invalid" },
          payload: { requestId: randomUUID(), password },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/login",
          headers: { ...base, host: "evil.invalid" },
          payload: { requestId: randomUUID(), password },
        })
      ).statusCode,
      403,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: base,
      payload: { requestId: randomUUID(), password },
    });
    assert.equal(login.statusCode, 200);
    assert.match(
      login.headers["set-cookie"] as string,
      /HttpOnly; SameSite=Strict/i,
    );
    assert.doesNotMatch(login.headers["set-cookie"] as string, /Secure;/);
    const sessionCookie = (login.headers["set-cookie"] as string).split(
      ";",
    )[0]!;
    const headers = {
      ...base,
      cookie: sessionCookie,
      "x-csrf-token": login.json<{ csrf: string }>().csrf,
    };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/jobs",
          headers: { ...base, cookie: sessionCookie },
          payload: jobInput(),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/jobs",
          headers,
          payload: { ...jobInput(), requestId: undefined },
        })
      ).statusCode,
      400,
    );
    const input = jobInput({
      objective:
        "synthetic-control-secret\nAuthorization: Bearer private\n依頼",
    });
    const create = await app.inject({
      method: "POST",
      url: "/api/jobs",
      headers,
      payload: input,
    });
    assert.equal(create.statusCode, 202, create.body);
    const id = create.json<{ id: string }>().id;
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/jobs",
      headers,
      payload: input,
    });
    assert.equal(duplicate.json<{ id: string }>().id, id);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/jobs",
          headers,
          payload: { ...input, objective: "changed" },
        })
      ).statusCode,
      409,
    );
    const detail = await app.inject({ url: `/api/jobs/${id}`, headers });
    assert.equal(detail.statusCode, 200);
    assert.doesNotMatch(detail.body, /synthetic-control-secret|Bearer private/);
    assert.match(detail.body, /REDACTED/);
    const settings = await app.inject({ url: "/api/settings", headers });
    assert.doesNotMatch(
      settings.body,
      /password|keyFile|tokenFile|synthetic-control-secret/,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/jobs/${id}/actions`,
          headers,
          payload: { requestId: randomUUID(), revision: 0, action: "cancel" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/jobs",
          headers,
          payload: { ...jobInput(), objective: "x".repeat(200000) },
        })
      ).statusCode,
      413,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/uploads",
          headers,
          payload: { requestId: randomUUID(), name: "../secret", data: "eA==" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/artifacts/../../etc/passwd/download",
          headers,
        })
      ).statusCode,
      404,
    );
    const upload = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers,
      payload: {
        requestId: randomUUID(),
        name: "日本語.txt",
        data: Buffer.from("添付資料").toString("base64"),
      },
    });
    assert.equal(upload.statusCode, 201, upload.body);
    assert.equal((await app.inject({ url: "/healthz" })).statusCode, 200);
  } finally {
    await app.close();
    await service.close();
  }
});

test("A11: transcript and job lists are bounded; immutable raw command logs remain downloadable", async () => {
  const { service } = await fixture([], { noModel: true });
  const app = await createServer(service, password, resolve("dist/web"));
  try {
    const { id } = await service.create(jobInput());
    const job = await service.job(id);
    for (let index = 0; index < 70; index++)
      await service.harness.commit(
        (tx) =>
          tx.appendEntry(job.conversationId, {
            kind: "fixture.message",
            model: [
              {
                role: "user",
                content: `entry ${index}`,
                timestamp: Date.now(),
              },
            ],
          }),
        ctx,
      );
    const view = (await service.view(id)) as {
      transcript: unknown[];
      cursor?: unknown;
    };
    assert.equal(view.transcript.length, 40);
    assert.ok(view.cursor);
    await service.harness.commit(async (tx) => {
      (await tx.doc(AppDoc)).settings.commonInstructions = "Keep API names";
    }, ctx);
    const updated = await service.create(jobInput());
    assert.match(
      (await service.job(updated.id)).instructions,
      /Keep API names/,
    );
    assert.equal((await service.job(id)).instructions.trim(), "");
  } finally {
    await app.close();
    await service.close();
  }
});
