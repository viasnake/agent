import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { skillsFixture } from "./skills-fixture.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fixture, until } from "./support.js";
import { createServer } from "../src/server.js";
import { SKILL_LIMITS, type SkillsManagement } from "../src/skills.js";

const content = (name = "sample", body = "Instructions") =>
  `---\nname: ${name}\ndescription: Sample skill\n---\n${body}`;
const entry = (path: string, text: string | Buffer) => ({
  path,
  data: Buffer.from(text).toString("base64"),
});

test("Skills management protects HTTP mutations, publishes complete imports and rejects stale edits/deletion", async () => {
  const s = await skillsFixture();
  const f = await fixture([], { root: s.root, skills: s.loader });
  const server = await createServer(f.service);
  try {
    const host = { host: "127.0.0.1:8080" };
    const session = await server.inject({ url: "/api/session", headers: host });
    const headers = {
      ...host,
      origin: "http://127.0.0.1:8080",
      cookie: session.headers["set-cookie"]!.toString().split(";")[0]!,
      "x-csrf-token": session.json().csrf,
    };
    const files = [
      entry("SKILL.md", content()),
      entry("scripts/run.py", 'raise RuntimeError("must not execute")'),
      entry("assets/data.bin", Buffer.from([0, 255, 42])),
    ];
    for (const unsafe of [
      host,
      { ...headers, "x-csrf-token": "wrong" },
      { ...headers, origin: "https://evil.example" },
    ])
      assert.ok(
        [401, 403].includes(
          (
            await server.inject({
              method: "POST",
              url: "/api/skills",
              headers: unsafe,
              payload: { files },
            })
          ).statusCode,
        ),
      );
    const imports = await Promise.all(
      [1, 2].map(() =>
        server.inject({
          method: "POST",
          url: "/api/skills",
          headers,
          payload: { files },
        }),
      ),
    );
    assert.deepEqual(
      imports.map((result) => result.statusCode).sort(),
      [200, 409],
    );
    const view = imports
      .find((result) => result.statusCode === 200)!
      .json<SkillsManagement>();
    assert.equal(view.writable, true);
    assert.equal(view.skills[0]!.state, "ready");
    assert.equal(
      (await stat(join(s.root, "skills/sample"))).mode & 0o777,
      0o755,
    );
    assert.equal(
      (await stat(join(s.root, "skills/sample/SKILL.md"))).mode & 0o777,
      0o644,
    );
    assert.deepEqual(
      await readFile(join(s.root, "skills/sample/assets/data.bin")),
      Buffer.from([0, 255, 42]),
    );
    const detail = await server.inject({ url: "/api/skills/sample", headers });
    assert.equal(detail.json().content, content());
    const revision = detail.json().revision;
    const edited = await server.inject({
      method: "PUT",
      url: "/api/skills/sample",
      headers,
      payload: { content: content("sample", "New instructions"), revision },
    });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(
      await readFile(join(s.root, "skills/sample/scripts/run.py"), "utf8"),
      'raise RuntimeError("must not execute")',
    );
    for (const method of ["PUT", "DELETE"] as const) {
      const stale = await server.inject({
        method,
        url: "/api/skills/sample",
        headers,
        payload: {
          revision,
          ...(method === "PUT" ? { content: content() } : {}),
        },
      });
      assert.equal(stale.statusCode, 409);
    }
    const current = edited.json<SkillsManagement>().skills[0]!.revision;
    const deleted = await server.inject({
      method: "DELETE",
      url: "/api/skills/sample",
      headers,
      payload: { revision: current },
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.deepEqual(deleted.json().skills, []);
    await assert.rejects(stat(join(s.root, "skills/sample")), {
      code: "ENOENT",
    });
    assert.equal(
      (await readdir(join(s.root, "control"))).some((name) =>
        name.startsWith("skill-"),
      ),
      false,
    );
    assert.equal(f.faux.state.callCount, 0);
  } finally {
    await server.close();
    await f.service.close();
    await rm(s.root, { recursive: true });
  }
});

test("Skill imports reject traversal, collisions and unbounded content before publishing any files", async () => {
  const s = await skillsFixture();
  const f = await fixture([], { root: s.root, skills: s.loader });
  try {
    const valid = entry("SKILL.md", content());
    for (const files of [
      [valid, entry("../outside", "x")],
      [valid, entry("/absolute", "x")],
      [valid, entry("a\\b", "x")],
      [valid, entry("a\nb", "x")],
      [valid, valid],
      [valid, entry("a", "x"), entry("a/b", "x")],
      [valid, entry("a/".repeat(10) + "b", "x")],
      [entry("SKILL.md", content("sample", "x".repeat(65536)))],
      [entry("SKILL.md", "not a skill")],
      [entry("reference.md", "missing SKILL.md")],
      [valid, { path: "invalid", data: "@@@" }],
      [
        valid,
        ...Array.from({ length: 17 }, (_, i) =>
          entry(`large-${i}`, "x".repeat(SKILL_LIMITS.resourceBytes)),
        ),
      ],
      [
        valid,
        ...Array.from({ length: 128 }, (_, i) => entry(`dir-${i}/file`, "x")),
      ],
    ]) {
      await assert.rejects(
        f.service.changeSkill({ kind: "create", input: { files } }),
      );
      assert.deepEqual(await readdir(join(s.root, "skills")), []);
    }
    await s.add("broken", "invalid: [");
    const detail = await f.service.skillDetail("broken");
    const result = await f.service.changeSkill({
      kind: "update",
      name: "broken",
      content: content("broken"),
      revision: detail.revision,
    });
    assert.equal(result.skills[0]!.state, "ready");
    const frozen = await s.loader.discover();
    await f.service.changeSkill({
      kind: "update",
      name: "broken",
      content: content("broken", "updated"),
      revision: result.skills[0]!.revision!,
    });
    await assert.rejects(frozen.activate("broken"), /変更/);
    const current = await f.service.skillDetail("broken");
    await writeFile(
      join(s.root, "skills/broken/new.txt"),
      "changed externally",
      { mode: 0o644 },
    );
    await assert.rejects(
      f.service.changeSkill({
        kind: "delete",
        name: "broken",
        revision: current.revision,
      }),
      /変更/,
    );
  } finally {
    await f.service.close();
    await rm(s.root, { recursive: true });
  }
});

test("Skills mutations share admission serialization and refuse updates throughout execution", async () => {
  const s = await skillsFixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(
    [
      async () => {
        await pending;
        return fauxAssistantMessage("done");
      },
    ],
    { root: s.root, skills: s.loader },
  );
  const create = s.loader.create.bind(s.loader);
  let publish!: () => void;
  const staged = new Promise<void>((resolve) => {
    publish = resolve;
  });
  let entered = false;
  s.loader.create = async (input) => {
    entered = true;
    await staged;
    await create(input);
  };
  try {
    const { id } = await f.service.create(randomUUID(), "Skill management");
    const importing = f.service.changeSkill({
      kind: "create",
      input: { files: [entry("SKILL.md", content())] },
    });
    await until(async () => entered);
    const sending = f.service.send(id, randomUUID(), "/skill:sample hello");
    assert.equal(f.faux.state.callCount, 0);
    publish();
    const view = await importing;
    await sending;
    await until(async () => f.faux.state.callCount === 1);
    assert.equal((await f.service.skillsManagement()).busy, true);
    for (const change of [
      { kind: "create", input: { files: [entry("SKILL.md", content("new"))] } },
      {
        kind: "update",
        name: "sample",
        content: content(),
        revision: view.skills[0]!.revision!,
      },
      { kind: "delete", name: "sample", revision: view.skills[0]!.revision! },
    ] satisfies Parameters<typeof f.service.changeSkill>[0][])
      await assert.rejects(f.service.changeSkill(change), /停止/);
    release();
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    await f.service.changeSkill({
      kind: "delete",
      name: "sample",
      revision: view.skills[0]!.revision!,
    });
    await assert.rejects(
      f.service.send(id, randomUUID(), "", true),
      /変更・削除/,
    );
    assert.equal(f.faux.state.callCount, 1);
  } finally {
    publish();
    release();
    await f.service.close();
    await rm(s.root, { recursive: true });
  }
});
