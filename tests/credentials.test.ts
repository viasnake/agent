import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, stat, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fixture, call, answer, until } from "./support.js";
import { createServer } from "../src/server.js";
import { settingsInput } from "../src/settings.js";
import { openSshAgent, sshPublicKey } from "../src/ssh-agent.js";
import { selectCredentials, workEnvironment } from "../src/work-credentials.js";

const exec = promisify(execFile);
function input(service: Awaited<ReturnType<typeof fixture>>["service"]) {
  const { pending: _, ...value } = service.management();
  return {
    revision: value.revision,
    models: [],
    defaultModel: null,
    mcp: [],
    instructions: value.instructions,
    limits: value.limits,
    workCredentials: value.workCredentials.map(({ id, name, kind }) => ({
      id,
      name,
      kind,
    })),
  };
}
async function keyFixture() {
  const dir = await mkdtemp(join(tmpdir(), "agent-key-test-"));
  const path = join(dir, "id");
  await exec("/usr/bin/ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    "fixture",
    "-f",
    path,
  ]);
  return {
    dir,
    path,
    key: await readFile(path, "utf8"),
    publicKey: (await readFile(path + ".pub", "utf8")).trim(),
  };
}

test("credential settings keep values private, revision-check edits, and preserve omitted values across restart", async () => {
  let f = await fixture();
  const key = await keyFixture(),
    envId = randomUUID(),
    sshId = randomUUID();
  let app = await createServer(f.service);
  try {
    const headers: Record<string, string> = {
      host: "127.0.0.1:8080",
      origin: "http://127.0.0.1:8080",
    };
    const session = await app.inject({ url: "/api/session", headers });
    headers.cookie = session.headers["set-cookie"]!.toString().split(";")[0]!;
    headers["x-csrf-token"] = session.json().csrf;
    const payload = {
      ...input(f.service),
      workCredentials: [
        {
          id: envId,
          name: "CLI",
          kind: "env",
          env: {
            GH_TOKEN: "fixture-private-pat",
            OTHER_TOKEN: "fixture-second-token",
          },
        },
        { id: sshId, name: "Git SSH", kind: "ssh", privateKey: key.key },
      ],
    };
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings",
          payload,
          headers: { ...headers, "x-csrf-token": "bad" },
        })
      ).statusCode,
      403,
    );
    const saved = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload,
      headers,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.ok(!saved.body.includes("fixture-private-pat"));
    assert.ok(!saved.body.includes("PRIVATE KEY"));
    assert.equal(saved.json().workCredentials[1].publicKey, key.publicKey);
    const publicResponse = await app.inject({
      url: "/api/credential-options",
      headers,
    });
    assert.ok(!publicResponse.body.includes("fixture-private-pat"));
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings",
          payload,
          headers,
        })
      ).statusCode,
      409,
    );
    const next = settingsInput.parse(input(f.service));
    next.workCredentials![0] = {
      id: envId,
      name: "CLI renamed",
      kind: "env",
      envKeep: ["GH_TOKEN"],
      env: { NEW_TOKEN: "replacement-token" },
    };
    await f.service.saveSettings(next);
    const credential = f.service.settings.snapshot().workCredentials[0]!;
    assert.equal(credential.kind, "env");
    if (credential.kind === "env")
      assert.deepEqual(credential.env, {
        GH_TOKEN: "fixture-private-pat",
        NEW_TOKEN: "replacement-token",
      });
    assert.equal(
      (await stat(join(f.root, "control/settings-v1.json"))).mode & 0o777,
      0o600,
    );
    const { id } = await f.service.create(
      randomUUID(),
      "selected",
      undefined,
      undefined,
      [envId, sshId],
    );
    await app.close();
    await f.service.close();
    f = await fixture([], { root: f.root });
    app = await createServer(f.service);
    assert.deepEqual((await f.service.conversation(id)).credentialIds, [
      envId,
      sshId,
    ]);
    assert.equal(f.service.settings.snapshot().workCredentials.length, 2);
    await f.service.saveSettings({ ...input(f.service), workCredentials: [] });
    await assert.rejects(
      f.service.send(id, randomUUID(), "start"),
      /クレデンシャル/,
    );
    await f.service.selectCredentials(id, []);
    assert.deepEqual((await f.service.conversation(id)).credentialIds, []);
    assert.ok(
      !JSON.stringify(f.service.management()).includes("fixture-private-pat"),
    );
  } finally {
    await app.close();
    await f.service.close();
    await rm(key.dir, { recursive: true, force: true });
  }
});

test("selected environment is frozen during a run, redacted before Pi storage, and absent from other sessions", async () => {
  const f = await fixture([
    call("bash", {
      command:
        "touch outputs/started; sleep 0.4; printf '%s' \"$GH_TOKEN\"; printf '%s' \"$GH_TOKEN\" | sha256sum > outputs/digest",
    }),
    answer("done"),
  ]);
  const credentialId = randomUUID(),
    first = "first-private-pat-value",
    second = "second-private-pat-value";
  try {
    await f.service.saveSettings({
      ...input(f.service),
      workCredentials: [
        {
          id: credentialId,
          name: "Git",
          kind: "env",
          env: { GH_TOKEN: first },
        },
      ],
    });
    const { id } = await f.service.create(
      randomUUID(),
      "selected",
      undefined,
      undefined,
      [credentialId],
    );
    await f.service.send(id, randomUUID(), "run");
    await until(async () =>
      access(join(f.root, "work/conversations", id, "outputs/started")).then(
        () => true,
        () => false,
      ),
    );
    await assert.rejects(f.service.selectCredentials(id, []), /終わって/);
    await f.service.saveSettings({
      ...input(f.service),
      workCredentials: [
        {
          id: credentialId,
          name: "Git",
          kind: "env",
          env: { GH_TOKEN: second },
        },
      ],
    });
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    const digest = () =>
      readFile(
        join(f.root, "work/conversations", id, "outputs/digest"),
        "utf8",
      );
    assert.ok(
      (await digest()).startsWith(
        createHash("sha256").update(first).digest("hex"),
      ),
    );
    const raw = JSON.stringify(
      await (
        await f.service.piConversation(id)
      ).entries({}, 100, undefined, ctx),
    );
    assert.ok(!raw.includes(first));
    assert.match(raw, /REDACTED/);
    f.faux.setResponses([
      call("bash", {
        command: "printf '%s' \"$GH_TOKEN\" | sha256sum > outputs/digest",
      }),
      answer("updated"),
    ]);
    await f.service.send(id, randomUUID(), "again");
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    assert.ok(
      (await digest()).startsWith(
        createHash("sha256").update(second).digest("hex"),
      ),
    );
    const other = await f.service.create(randomUUID(), "unselected");
    f.faux.setResponses([
      call("bash", {
        command: 'test -z "${GH_TOKEN-}${SSH_AUTH_SOCK-}" && echo absent',
      }),
      answer("clean"),
    ]);
    await f.service.send(other.id, randomUUID(), "check");
    await until(
      async () => (await f.service.conversation(other.id)).status === "idle",
    );
    assert.match(JSON.stringify(await f.service.view(other.id)), /absent/);
    const entry = (await f.service.view(id)).transcript.find((entry) =>
      entry.messages.some((m) => m.role === "assistant"),
    )!;
    const branch = await f.service.branch(id, randomUUID(), entry.id, "fork");
    assert.deepEqual((await f.service.conversation(branch.id)).credentialIds, [
      credentialId,
    ]);
  } finally {
    await f.service.close();
  }
});

test("credential validation rejects collisions, managed variables and invalid SSH keys", async () => {
  for (const name of [
    "PATH",
    "HOME",
    "SSH_AUTH_SOCK",
    "LD_PRELOAD",
    "NODE_OPTIONS",
    "BASH_ENV",
  ])
    assert.equal(workEnvironment.safeParse({ [name]: "value" }).success, false);
  assert.equal(workEnvironment.safeParse({ TOKEN: "a\0b" }).success, false);
  const a = randomUUID(),
    b = randomUUID();
  assert.throws(
    () =>
      selectCredentials(
        [
          { id: a, name: "A", kind: "env", env: { GH_TOKEN: "one" } },
          { id: b, name: "B", kind: "env", env: { GH_TOKEN: "two" } },
        ],
        [a, b],
      ),
    /重複/,
  );
  await assert.rejects(sshPublicKey("not-a-key"), /SSH 鍵/);
});

test("short environment values do not corrupt session identifiers", async () => {
  const f = await fixture();
  try {
    const credentialId = randomUUID();
    await f.service.saveSettings({
      ...input(f.service),
      workCredentials: [
        { id: credentialId, name: "Flags", kind: "env", env: { FLAG: "1" } },
      ],
    });
    assert.equal(f.service.management().workCredentials[0]!.id, credentialId);
    assert.equal(f.service.redact("value: 1"), "value: [REDACTED]");
    assert.equal(
      f.service.redact("11223344-1111-4111-8111-111111111111"),
      "11223344-1111-4111-8111-111111111111",
    );
  } finally {
    await f.service.close();
  }
});

test("real OpenSSH signer lists and signs without exposing its private socket and refuses mutations", async () => {
  const key = await keyFixture();
  const agent = await openSshAgent([key.key], process.getuid!());
  const env = { PATH: "/usr/bin:/bin", SSH_AUTH_SOCK: agent.socket };
  try {
    assert.equal(
      (await exec("/usr/bin/ssh-add", ["-L"], { env })).stdout.trim(),
      key.publicKey,
    );
    // OpenSSH verifies a real signature using the agent-held key.
    await exec("/usr/bin/ssh-add", ["-T", key.path + ".pub"], { env });
    await assert.rejects(exec("/usr/bin/ssh-add", ["-D"], { env }));
    await exec("/usr/bin/ssh-add", ["-T", key.path + ".pub"], { env });
    const socket = createConnection(agent.socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    await agent.close();
    await assert.rejects(access(agent.socket));
    await new Promise<void>((resolve) => {
      if (socket.destroyed) resolve();
      else socket.once("close", resolve);
    });
  } finally {
    await agent.close();
    await rm(key.dir, { recursive: true, force: true });
  }
});

test("session bash receives a disposable SSH socket and never receives the private key", async () => {
  const f = await fixture([
    call("bash", {
      command:
        "ssh-add -L; printf '%s' \"$SSH_AUTH_SOCK\" > outputs/socket; env",
    }),
    answer("done"),
  ]);
  try {
    const sshId = randomUUID();
    await f.service.saveSettings({
      ...input(f.service),
      workCredentials: [
        { id: sshId, name: "SSH", kind: "ssh", generateKey: true },
      ],
    });
    const { id } = await f.service.create(
      randomUUID(),
      "SSH",
      undefined,
      undefined,
      [sshId],
    );
    await f.service.send(id, randomUUID(), "check");
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    const view = JSON.stringify(await f.service.view(id));
    assert.match(view, /ssh-ed25519/);
    assert.ok(!view.includes("PRIVATE KEY"));
    const socket = await readFile(
      join(f.root, "work/conversations", id, "outputs/socket"),
      "utf8",
    );
    await assert.rejects(access(socket));
  } finally {
    await f.service.close();
  }
});

test("stopping a command revokes its SSH socket before another session can execute", async () => {
  const key = await keyFixture();
  const f = await fixture([
    call("bash", {
      command: "printf '%s' \"$SSH_AUTH_SOCK\" > outputs/socket; sleep 20",
    }),
  ]);
  try {
    const sshId = randomUUID();
    await f.service.saveSettings({
      ...input(f.service),
      workCredentials: [
        { id: sshId, name: "SSH", kind: "ssh", privateKey: key.key },
      ],
    });
    const { id } = await f.service.create(
      randomUUID(),
      "stop SSH",
      undefined,
      undefined,
      [sshId],
    );
    await f.service.send(id, randomUUID(), "start");
    const path = join(f.root, "work/conversations", id, "outputs/socket");
    await until(async () =>
      access(path).then(
        () => true,
        () => false,
      ),
    );
    const socket = await readFile(path, "utf8");
    await access(socket);
    await f.service.stop(id);
    await assert.rejects(access(socket));
    assert.equal((await f.service.conversation(id)).status, "interrupted");
  } finally {
    await f.service.close();
    await rm(key.dir, { recursive: true, force: true });
  }
});
