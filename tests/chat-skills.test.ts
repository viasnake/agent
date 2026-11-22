import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { skillsFixture } from "./skills-fixture.js";
import { answer, call, fixture, until } from "./support.js";

const draft = (name: string, body: string) => ({
  name,
  content: `---\nname: ${name}\ndescription: Verified instructions\n---\n${body}`,
  summary: "手順を整理",
});

test("ordinary work creates a Skill without a command or settings change", async () => {
  const s = await skillsFixture();
  const newSkill = draft("new-skill", "Checked the steps");
  const f = await fixture([call("skill_save", newSkill), answer("Prepared")], {
    root: s.root,
    skills: s.loader,
  });
  try {
    const { id } = await f.service.create(randomUUID(), "Work");
    const request = randomUUID();
    await f.service.send(id, request, "再利用できる手順を確認して");
    await until(async () => !!(await f.service.conversation(id)).skillNotice);
    assert.match(
      (await f.service.conversation(id)).skillNotice!,
      /登録しました：手順を整理/,
    );
    await f.service.send(id, request, "再利用できる手順を確認して");
    assert.equal(
      (await s.loader.detail("new-skill")).content,
      newSkill.content,
    );
  } finally {
    await f.service.close();
    await rm(s.root, { recursive: true });
  }
});

test("existing Skills are maintained without opt-in and stale drafts cannot overwrite a newer revision", async () => {
  const s = await skillsFixture();
  const directory = await s.add("existing");
  const resource = join(directory, "reference.txt");
  await writeFile(resource, "unchanged");
  const first = draft("existing", "First revision");
  const stale = draft("existing", "Stale revision");
  const f = await fixture(
    [
      call("skill_save", first),
      answer("Prepared"),
      call("skill_save", stale),
      answer("Prepared another version"),
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
    const { id } = await f.service.create(randomUUID(), "Update");
    const { id: next } = await f.service.create(
      randomUUID(),
      "Concurrent draft",
    );
    await f.service.send(id, randomUUID(), "確認した手順を反映して");
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    await f.service.send(next, randomUUID(), "こちらの手順も確認して");
    await until(
      async () => (await f.service.conversation(next)).status === "idle",
    );
    assert.equal((await f.service.conversation(id)).skillNotice, undefined);
    assert.match(
      (await s.loader.detail("existing")).content,
      /PRIVATE SKILL BODY/,
    );
    closeTerminal();
    await terminal;
    assert.match(
      (await f.service.conversation(id)).skillNotice!,
      /更新しました/,
    );
    assert.match(
      (await f.service.conversation(next)).skillNotice!,
      /Skill が変更されています/,
    );
    assert.equal((await s.loader.detail("existing")).content, first.content);
    assert.equal(await readFile(resource, "utf8"), "unchanged");
  } finally {
    closeTerminal();
    await terminal;
    await f.service.close();
    await rm(s.root, { recursive: true });
  }
});
