import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir as mkdirRaw,
  readFile,
  rename,
  rm,
  symlink,
  writeFile as writeFileRaw,
} from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import {
  fauxAssistantMessage,
  fauxToolCall,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { SkillsLoader, SKILL_LIMITS, parseSkill } from "../src/skills.js";
import { skillsFixture } from "./skills-fixture.js";
import { answer, call, fixture, until } from "./support.js";
import { createServer } from "../src/server.js";

const mkdir = (path: string) => mkdirRaw(path, { mode: 0o755 });
const writeFile = (path: string, data: string | Buffer) =>
  writeFileRaw(path, data, { mode: 0o644 });

const idle = async (
  service: Awaited<ReturnType<typeof fixture>>["service"],
  id: string,
) => until(async () => (await service.conversation(id)).status === "idle");
test("Skills parse standard YAML fields, isolate invalid declarations and reject aliases and duplicate names", async () => {
  const s = await skillsFixture();
  await s.add(
    "valid",
    'name: valid\ndescription: |\n  Multiline description\nlicense: MIT\ncompatibility: Python 3\nmetadata:\n  author: "test"\nallowed-tools: Bash(sudo:*)\nfuture-field: ignored',
  );
  await s.add("bad-yaml", "name: [");
  await s.add("wrong", "name: valid\ndescription: duplicate");
  await s.add("no-description", "name: no-description\ndescription: ''");
  await s.add("PDF", "name: PDF\ndescription: uppercase");
  await s.add("other");
  const snapshot = await s.loader.discover();
  assert.equal(
    snapshot.view.skills.filter((x) => x.state === "ready").length,
    1,
  );
  assert.equal(
    snapshot.view.skills.find((x) => x.name === "valid")?.error,
    "Skill 名が重複しています",
  );
  await assert.rejects(snapshot.activate("valid"), /利用できません/);
  assert.equal((await snapshot.activate("other")).body, "PRIVATE SKILL BODY");
  const parsed = parseSkill(
    Buffer.from(
      '---\nname: valid\ndescription: >\n  first\n  second\nmetadata:\n  version: "1"\nallowed-tools: Bash(sudo:*)\nunknown: true\n---\nbody',
    ),
  );
  assert.equal(parsed.metadata.description, "first second");
  assert.equal(parsed.metadata["allowed-tools"], "Bash(sudo:*)");
  assert.equal(Object.hasOwn(parsed.metadata, "unknown"), false);
  for (const field of [
    "name: a--b\ndescription: x",
    "name: -a\ndescription: x",
    "name: a-\ndescription: x",
    `name: a\ndescription: ${"x".repeat(1025)}`,
    "name: a\ndescription: x\nmetadata: {version: 1}",
    "name: a\ndescription: &a hello\nlicense: *a",
    "name: a\nname: b\ndescription: x",
  ])
    assert.throws(() => parseSkill(Buffer.from(`---\n${field}\n---\n`)));
  await rm(s.root, { recursive: true });
});

test("Skills enforce ownership, component paths, no links, bounded reads, file replacement and text decoding", async () => {
  const s = await skillsFixture(),
    directory = await s.add("safe");
  await mkdir(join(directory, "references"));
  await writeFile(join(directory, "references/good.md"), "reference");
  await writeFile(join(directory, "binary"), Buffer.from([0, 255]));
  const snapshot = await s.loader.discover();
  for (const path of [
    "../control/secret",
    "/etc/passwd",
    "references/../SKILL.md",
    "references//good.md",
    "references\\good.md",
  ])
    await assert.rejects(snapshot.resource("safe", path));
  assert.equal(
    (await snapshot.resource("safe", "references/good.md")).text,
    "reference",
  );
  await assert.rejects(snapshot.resource("safe", "binary"), /UTF-8/);
  await rename(
    join(directory, "references/good.md"),
    join(directory, "references/old.md"),
  );
  await symlink("/etc/passwd", join(directory, "references/good.md"));
  await assert.rejects(snapshot.resource("safe", "references/good.md"));
  await rm(join(directory, "references/good.md"));
  await writeFile(join(directory, "references/good.md"), "new");
  await assert.rejects(snapshot.resource("safe", "references/good.md"), /変更/);
  await link(join(directory, "SKILL.md"), join(directory, "hardlink"));
  assert.equal((await s.loader.discover()).view.skills[0]?.state, "invalid");
  await rm(join(directory, "hardlink"));
  await chmod(directory, 0o777);
  assert.equal((await s.loader.discover()).view.skills[0]?.state, "invalid");
  await chmod(directory, 0o755);
  await chmod(join(s.root, "skills"), 0o777);
  await assert.rejects(s.loader.discover(), /所有者/);
  await chmod(join(s.root, "skills"), 0o755);
  await assert.rejects(new SkillsLoader(s.root).discover(), /所有者/);
  await rename(join(s.root, "skills"), join(s.root, "old"));
  await symlink(join(s.root, "old"), join(s.root, "skills"));
  await assert.rejects(s.loader.discover());
  await rm(s.root, { recursive: true });
});

test("Skills bound discovery counts, file sizes and tree sizes, and handle an absent root", async () => {
  const s = await skillsFixture();
  await s.add("large", undefined, "x".repeat(SKILL_LIMITS.fileBytes));
  const many = await s.add("many");
  for (let i = 0; i < SKILL_LIMITS.files; i++)
    await writeFile(join(many, `file-${i}`), "");
  assert.ok(
    (await s.loader.discover()).view.skills.every((x) => x.state === "invalid"),
  );
  for (let i = 0; i < SKILL_LIMITS.entries; i++)
    await writeFile(join(s.root, "skills", `entry-${i}`), "");
  assert.match((await s.loader.discover()).view.errors.join(), /探索件数/);
  await rm(join(s.root, "skills"), { recursive: true });
  const empty = await s.loader.discover();
  assert.equal(empty.catalog(), "");
  assert.deepEqual(empty.view, { skills: [], errors: [] });
  await rm(s.root, { recursive: true });
});

test("Pi Skills disclose metadata only, activate and read dynamically, and execute through the existing worker", async () => {
  const s = await skillsFixture(),
    directory = await s.add(
      "pdf-processing",
      "name: pdf-processing\ndescription: Process PDF\nallowed-tools: RootShell",
      "PRIVATE SKILL BODY: inspect references then run script",
    );
  await mkdir(join(directory, "references"));
  await mkdir(join(directory, "scripts"));
  await writeFile(
    join(directory, "references/formats.md"),
    "REFERENCE CONTENT",
  );
  await writeFile(
    join(directory, "scripts/extract.py"),
    'from pathlib import Path\nPath("outputs/result.txt").write_text("processed")\n',
  );
  let observed = 0;
  const f = await fixture(
    [
      (context) => {
        const content = JSON.stringify(context.messages);
        assert.match(content, /Process PDF/);
        assert.doesNotMatch(content, /PRIVATE SKILL BODY|RootShell/);
        observed++;
        return fauxAssistantMessage(
          fauxToolCall("skill_activate", { name: "pdf-processing" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        assert.match(JSON.stringify(context.messages), /PRIVATE SKILL BODY/);
        observed++;
        return fauxAssistantMessage(
          fauxToolCall("skill_read_resource", {
            name: "pdf-processing",
            path: "references/formats.md",
          }),
          { stopReason: "toolUse" },
        );
      },
      call("bash", { command: `python3 ${directory}/scripts/extract.py` }),
      answer("完了"),
    ],
    { root: s.root, skills: s.loader },
  );
  try {
    const { id } = await f.service.create(randomUUID(), "PDF");
    await f.service.send(id, randomUUID(), "PDF を処理して");
    await idle(f.service, id);
    assert.equal(observed, 2);
    assert.equal(
      (await f.service.download(id, "outputs/result.txt")).toString(),
      "processed",
    );
    assert.match(JSON.stringify(await f.service.view(id)), /REFERENCE CONTENT/);
  } finally {
    await f.service.close();
    await rm(s.root, { recursive: true });
  }
});

test("explicit Skills are injected before inference, retained outside history, deduplicated, and reject steering", async () => {
  const s = await skillsFixture();
  await s.add("code-review");
  let observed = 0,
    release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(
    [
      async (context) => {
        assert.match(JSON.stringify(context.messages), /PRIVATE SKILL BODY/);
        assert.ok(
          context.messages.some(
            (message) =>
              message.role === "user" && message.content === "コードを確認して",
          ),
        );
        observed++;
        await barrier;
        return fauxAssistantMessage("確認しました");
      },
      answer("追加も確認しました"),
    ],
    { root: s.root, skills: s.loader },
  );
  try {
    const { id } = await f.service.create(randomUUID(), "Review"),
      request = randomUUID(),
      input = "/skill:code-review コードを確認して";
    await assert.rejects(
      f.service.send(id, randomUUID(), "/skill:missing test"),
      /利用できません/,
    );
    await f.service.send(id, request, input);
    await until(async () => observed === 1);
    await assert.rejects(f.service.send(id, randomUUID(), input), /停止後/);
    await f.service.send(id, randomUUID(), "追加の指示");
    release();
    await idle(f.service, id);
    const view = JSON.stringify(await f.service.view(id));
    assert.match(view, /\/skill:code-review コードを確認して/);
    assert.doesNotMatch(view, /PRIVATE SKILL BODY/);
    await rm(join(s.root, "skills/code-review"), { recursive: true });
    await f.service.send(id, request, input);
    await assert.rejects(
      f.service.send(id, randomUUID(), "", true),
      /変更・削除/,
    );
  } finally {
    release();
    await f.service.close();
    await rm(s.root, { recursive: true });
  }
});

test("running Skills remain frozen when files or the settings catalog change; next admission refreshes", async () => {
  const s = await skillsFixture(),
    dir = await s.add("one");
  let observed = 0;
  const f = await fixture(
    [
      async (context) => {
        assert.doesNotMatch(JSON.stringify(context.messages), /second skill/);
        await s.add("two", "name: two\ndescription: second skill");
        await writeFile(
          join(dir, "SKILL.md"),
          "---\nname: one\ndescription: changed\n---\nNEW BODY",
        );
        await f.service.skills.discover();
        observed++;
        return fauxAssistantMessage(
          fauxToolCall("skill_activate", { name: "one" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const value = JSON.stringify(context.messages);
        assert.match(value, /変更/);
        assert.doesNotMatch(value, /NEW BODY|second skill/);
        observed++;
        return fauxAssistantMessage("停止して確認してください");
      },
    ],
    { root: s.root, skills: s.loader },
  );
  try {
    const { id } = await f.service.create(randomUUID(), "frozen");
    await f.service.send(id, randomUUID(), "work");
    await idle(f.service, id);
    assert.equal(observed, 2);
    f.faux.setResponses([
      (context) => {
        assert.match(JSON.stringify(context.messages), /second skill/);
        observed++;
        return fauxAssistantMessage("new run");
      },
    ]);
    await f.service.send(id, randomUUID(), "new input");
    await idle(f.service, id);
    assert.equal(observed, 3);
  } finally {
    await f.service.close();
    await rm(s.root, { recursive: true });
  }
});

test("Skills API applies local sessions and rejects arbitrary paths without disclosing content", async () => {
  const s = await skillsFixture();
  await s.add("safe");
  await s.add("bad", "invalid: [");
  const f = await fixture([], { root: s.root, skills: s.loader }),
    server = await createServer(f.service);
  try {
    const headers = { host: "127.0.0.1:8080" };
    assert.equal(
      (await server.inject({ url: "/api/skills", headers })).statusCode,
      401,
    );
    const session = await server.inject({ url: "/api/session", headers });
    const authenticated = {
      ...headers,
      cookie: session.headers["set-cookie"]!.toString().split(";")[0]!,
    };
    const response = await server.inject({
      url: "/api/skills",
      headers: authenticated,
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /invalid/);
    assert.doesNotMatch(response.body, /PRIVATE SKILL BODY/);
    assert.equal(
      (
        await server.inject({
          url: "/api/skills?path=/etc/passwd",
          headers: authenticated,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await server.inject({
          url: "/api/skills",
          headers: { ...authenticated, "sec-fetch-site": "cross-site" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await server.inject({
          url: "/api/skills/safe/SKILL.md",
          headers: authenticated,
        })
      ).statusCode,
      404,
    );
  } finally {
    await server.close();
    await f.service.close();
    await rm(s.root, { recursive: true });
  }
});

test("stopped Skill scripts are not replayed on reopen; explicit resume retains the version and context", async () => {
  const s = await skillsFixture(),
    directory = await s.add("script");
  await writeFile(
    join(directory, "run.sh"),
    "printf effect >> outputs/effects.txt\nprintf ready > started\nsleep 30\n",
  );
  let f = await fixture([call("bash", { command: `sh ${directory}/run.sh` })], {
    root: s.root,
    skills: s.loader,
  });
  const { id } = await f.service.create(randomUUID(), "stop");
  try {
    await f.service.send(id, randomUUID(), "/skill:script run");
    await until(async () =>
      readFile(join(s.root, "work/conversations", id, "started")).then(
        () => true,
        () => false,
      ),
    );
    await f.service.stop(id);
    await f.service.close();
    let observed = false;
    f = await fixture(
      [
        (context) => {
          assert.match(JSON.stringify(context.messages), /PRIVATE SKILL BODY/);
          observed = true;
          return fauxAssistantMessage("既存の結果を確認しました");
        },
      ],
      { root: s.root, skills: s.loader },
    );
    assert.equal(f.faux.state.callCount, 0);
    assert.equal(
      (await f.service.download(id, "outputs/effects.txt")).toString(),
      "effect",
    );
    await f.service.send(id, randomUUID(), "", true);
    await idle(f.service, id);
    assert.equal(observed, true);
    assert.equal(
      (await f.service.download(id, "outputs/effects.txt")).toString(),
      "effect",
    );
  } finally {
    await f.service.close();
    await rm(s.root, { recursive: true });
  }
});

test("no Skills adds no Skill prompt or tools", async () => {
  let checked = false;
  const f = await fixture([
    (context) => {
      assert.doesNotMatch(
        JSON.stringify(context.messages),
        /Available Skills|skill_activate|skill_read_resource/,
      );
      checked = true;
      return fauxAssistantMessage("normal");
    },
  ]);
  try {
    const { id } = await f.service.create(randomUUID(), "normal");
    await f.service.send(id, randomUUID(), "hello");
    await idle(f.service, id);
    assert.equal(checked, true);
  } finally {
    await f.service.close();
  }
});

test("discovery aggregate bytes and resource reads are bounded without running Skill content", async () => {
  const s = await skillsFixture();
  for (let i = 0; i < 18; i++)
    await s.add(`skill-${i}`, undefined, "x".repeat(64000));
  let snapshot = await s.loader.discover();
  assert.ok(snapshot.view.skills.some((row) => row.state === "invalid"));
  await rm(join(s.root, "skills"), { recursive: true });
  await mkdir(join(s.root, "skills"));
  const directory = await s.add("resources");
  await writeFile(
    join(directory, "large.txt"),
    "x".repeat(SKILL_LIMITS.resourceBytes + 1),
  );
  await writeFile(join(directory, "script.sh"), "touch should-never-exist");
  snapshot = await s.loader.discover();
  await assert.rejects(snapshot.resource("resources", "large.txt"), /サイズ/);
  await assert.rejects(readFile(join(s.root, "should-never-exist")), {
    code: "ENOENT",
  });
  await rm(s.root, { recursive: true });
});

test("explicit Skill request transformation preserves admitted image bytes and the original history", async () => {
  const s = await skillsFixture();
  await s.add("review");
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const faux = fauxProvider({
    tokensPerSecond: Infinity,
    models: [{ id: "faux-1", input: ["text", "image"] }],
  });
  let observed = false;
  faux.setResponses([
    (context) => {
      const message = context.messages.findLast(
        (message) => message.role === "user",
      );
      assert.ok(message && Array.isArray(message.content));
      assert.deepEqual(message.content, [
        { type: "text", text: "画像を確認して" },
        {
          type: "image",
          mimeType: "image/png",
          data: bytes.toString("base64"),
        },
      ]);
      assert.match(JSON.stringify(context.messages), /PRIVATE SKILL BODY/);
      observed = true;
      return fauxAssistantMessage("確認しました");
    },
  ]);
  const f = await fixture([], {
    root: s.root,
    skills: s.loader,
    provider: faux.provider,
  });
  try {
    const { id } = await f.service.create(randomUUID(), "image");
    const file = await f.service.upload(id, randomUUID(), "image.png", bytes),
      requestId = randomUUID();
    await f.service.send(id, requestId, "/skill:review 画像を確認して", false, [
      file.path,
    ]);
    await idle(f.service, id);
    assert.equal(observed, true);
    await writeFile(
      join(s.root, "work/conversations", id, file.path),
      "modified",
    );
    await f.service.send(id, requestId, "/skill:review 画像を確認して", false, [
      file.path,
    ]);
    assert.equal(faux.state.callCount, 1);
    const view = JSON.stringify(await f.service.view(id));
    assert.match(view, /\/skill:review 画像を確認して/);
    assert.doesNotMatch(view, /PRIVATE SKILL BODY/);
  } finally {
    await f.service.close();
    await rm(s.root, { recursive: true });
  }
});

test("regenerating an earlier explicit input uses its own Skill metadata, without activating or running at branch creation", async () => {
  const s = await skillsFixture();
  await s.add("first", undefined, "FIRST BODY");
  await s.add("second", undefined, "SECOND BODY");
  const f = await fixture([answer("First answer"), answer("Second answer")], {
    root: s.root,
    skills: s.loader,
  });
  try {
    const { id } = await f.service.create(randomUUID(), "regenerate");
    await f.service.send(id, randomUUID(), "/skill:first first");
    await idle(f.service, id);
    const entry = (await f.service.view(id)).transcript.find((entry) =>
      entry.messages.some((message) => message.role === "assistant"),
    )!;
    await f.service.send(id, randomUUID(), "/skill:second second");
    await idle(f.service, id);
    const branch = await f.service.branch(
      id,
      randomUUID(),
      entry.id,
      "regenerate",
    );
    assert.equal(f.faux.state.callCount, 2);
    assert.equal(
      (await f.service.conversation(branch.id)).workspaceCreated,
      false,
    );
    let observed = false;
    f.faux.setResponses([
      (context) => {
        assert.match(JSON.stringify(context.messages), /FIRST BODY/);
        assert.doesNotMatch(JSON.stringify(context.messages), /SECOND BODY/);
        observed = true;
        return fauxAssistantMessage("regenerated");
      },
    ]);
    await f.service.send(branch.id, randomUUID(), "", false, [], {
      continuing: true,
    });
    await idle(f.service, branch.id);
    assert.equal(observed, true);
    assert.match(JSON.stringify(await f.service.view(id)), /Second answer/);
  } finally {
    await f.service.close();
    await rm(s.root, { recursive: true });
  }
});
