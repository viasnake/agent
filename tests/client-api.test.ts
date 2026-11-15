import { test } from "node:test";
import assert from "node:assert/strict";
import { api, ApiError, setCsrf } from "../web/api.js";

test("concurrent expired browser requests share reconnection and keep their original mutation bodies", async (t) => {
  setCsrf("expired");
  let reconnects = 0;
  const bodies: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (path: string, init?: RequestInit) => {
      if (path === "/api/session") {
        reconnects++;
        return Response.json({ csrf: "renewed" });
      }
      bodies.push(String(init?.body));
      if (new Headers(init?.headers).get("X-CSRF-Token") === "expired")
        return Response.json({ code: "session_expired" }, { status: 401 });
      assert.equal(new Headers(init?.headers).get("X-CSRF-Token"), "renewed");
      return Response.json({ ok: true });
    },
  );
  const payload = { requestId: "original-request" };
  await Promise.all([
    api("/api/a", "POST", payload),
    api("/api/b", "DELETE", payload),
  ]);
  assert.equal(reconnects, 1);
  assert.deepEqual(bodies, Array(4).fill(JSON.stringify(payload)));
});

test("mutation errors and ambiguous transport failures never trigger automatic replay", async (t) => {
  for (const failure of [401, 403, 503, "transport"] as const) {
    let requests = 0;
    const mock = t.mock.method(globalThis, "fetch", async () => {
      requests++;
      if (failure === "transport") throw new TypeError("Connection lost");
      return Response.json({ error: "failed" }, { status: failure });
    });
    await assert.rejects(api("/api/mutation", "POST", {}));
    assert.equal(requests, 1);
    mock.mock.restore();
  }
});

test("a second session rejection fails instead of looping", async (t) => {
  setCsrf("old");
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (path: string) => {
    requests++;
    return path === "/api/session"
      ? Response.json({ csrf: "new" })
      : Response.json(
          { code: "session_expired", error: "expired" },
          { status: 401 },
        );
  });
  await assert.rejects(
    api("/api/mutation", "DELETE", {}),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  assert.equal(requests, 3);
});
