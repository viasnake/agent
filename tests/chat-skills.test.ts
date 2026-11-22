import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { skillsFixture } from "./skills-fixture.js";
import { answer, call, fixture, until } from "./support.js";

const idle = async (
  service: Awaited<ReturnType<typeof fixture>>["service"],
  id: string,
) => until(async () => (await service.conversation(id)).status === "idle");

test("chat saves only the explicitly chosen Skill after other runs and terminals finish", async () => {
  const s = await skillsFixture();
  const old = await s.add("existing");
  const resource = join(old, "reference.txt");
  await writeFile(resource, "unchanged");
  const updated =
    "---\nname: existing\ndescription: Updated instructions\n---\nNew body";
  let unblock!: () => void;
  const barrier = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let waiting = false;
  const f = await fixture(
    [
      async () => {
        waiting = true;
        await barrier;
        return fauxAssistantMessage("done");
      },
      call("skill_save", { content: updated.replace("existing", "wrong") }),
      call("skill_save", { content: updated }),
      answer("Prepared"),
    ],
    { root: s.root, skills: s.loader },
  );
  let closeTerminal!: () => void;
  const terminalClosed = new Promise<void>((resolve) => {
    closeTerminal = resolve;
  });
  let terminalReady = false;
  f.service.runner.terminal = async () => {
    terminalReady = true;
    await terminalClosed;
  };
  const terminal = f.service.terminal(
    { ready() {}, output() {} },
    new AbortController().signal,
  );
  try {
    await until(async () => terminalReady);
    const { id: other } = await f.service.create(randomUUID(), "Other");
    const { id } = await f.service.create(randomUUID(), "Update");
    await f.service.send(other, randomUUID(), "Wait");
    await until(async () => waiting);
    await assert.rejects(
      f.service.send(id, randomUUID(), "/skill-create:existing duplicate"),
      /同名/,
    );
    await f.service.send(
      id,
      randomUUID(),
      "/skill-update:existing Update body",
    );
    await idle(f.service, id);
    assert.equal(
      (await s.loader.discover()).view.skills.some(
        (item) => item.name === "wrong",
      ),
      false,
    );
    assert.match(
      (await s.loader.detail("existing")).content,
      /PRIVATE SKILL BODY/,
    );
    assert.equal((await f.service.conversation(id)).skillNotice, undefined);
    unblock();
    await idle(f.service, other);
    assert.match(
      (await s.loader.detail("existing")).content,
      /PRIVATE SKILL BODY/,
    );
    assert.equal((await f.service.conversation(id)).skillNotice, undefined);
    closeTerminal();
    await terminal;
    await until(async () => !!(await f.service.conversation(id)).skillNotice);
    assert.match(
      (await f.service.conversation(id)).skillNotice!,
      /更新しました/,
    );
    assert.equal((await s.loader.detail("existing")).content, updated);
    assert.equal(await readFile(resource, "utf8"), "unchanged");
  } finally {
    unblock();
    closeTerminal();
    await terminal;
    await f.service.close();
    await rm(s.root, { recursive: true });
  }
});

test("chat can create the first Skill and cannot reuse past authorization", async () => {
  const s = await skillsFixture();
  const content = "---\nname: new-skill\ndescription: A new Skill\n---\nBody";
  const f = await fixture(
    [
      call("skill_save", { content }),
      answer("No authorization"),
      call("skill_save", { content }),
      answer("Prepared"),
      call("skill_save", { content: content.replace("Body", "Unauthorized") }),
      answer("No reuse"),
    ],
    { root: s.root, skills: s.loader },
  );
  try {
    const { id } = await f.service.create(randomUUID(), "Create");
    await f.service.send(
      id,
      randomUUID(),
      "Quoted instructions: /skill-create:new-skill create",
    );
    await idle(f.service, id);
    assert.equal((await s.loader.discover()).view.skills.length, 0);
    const request = randomUUID();
    await f.service.send(
      id,
      request,
      "/skill-create:new-skill Create the Skill",
    );
    await until(async () => !!(await f.service.conversation(id)).skillNotice);
    assert.match(
      (await f.service.conversation(id)).skillNotice!,
      /登録しました/,
    );
    await f.service.send(
      id,
      request,
      "/skill-create:new-skill Create the Skill",
    );
    await f.service.send(id, randomUUID(), "Now summarize the work");
    await idle(f.service, id);
    assert.equal((await s.loader.detail("new-skill")).content, content);
  } finally {
    await f.service.close();
    await rm(s.root, { recursive: true });
  }
});
