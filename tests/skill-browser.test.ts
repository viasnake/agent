import assert from "node:assert/strict";
import test from "node:test";
import type { Application } from "../src/application.js";
import { SkillBrowser } from "../src/tui/skill-browser.js";
import { fixture, gitWorkspace, ScriptedRuntime } from "./helpers.js";

test("skill browser preserves drafts on cancel or stale view, and stages only explicitly selected references", async () => {
  const f = await fixture(
    new ScriptedRuntime(async () => assert.fail("No inference")),
  );
  try {
    const path = "skills/example/SKILL.md";
    const ref = "skills/example/references/style.md";
    const workspace = await gitWorkspace(f.root, {
      [path]: "# Skill\n```\nplain text",
      [ref]: "参考",
    });
    const app = {
      busy: false,
      session: { id: "current", workspace, draft: "既存の依頼" },
      config: f.config,
      setDraft(text: string) {
        this.session.draft = text;
      },
    };
    const choices: (string | undefined)[] = [];
    let confirm = false;
    let active = true;
    let changeDuringShow = false;
    const shown: string[] = [];
    const dialogs = {
      choose: async () => choices.shift(),
      show: async (text: string) => {
        shown.push(text);
        if (changeDuringShow) app.session.draft = "変更済み";
        return true;
      },
      confirm: async () => confirm,
      notice: () => {},
      active: () => active,
    };
    const browser = new SkillBrowser(app as unknown as Application, dialogs);
    choices.push("done");
    await browser.select(path);
    assert.equal(app.session.draft, "既存の依頼");
    confirm = true;
    choices.push(ref, ref, ref, "done");
    await browser.select(path);
    assert.equal(app.session.draft, `既存の依頼\n@"skill:${path}"\n@"${ref}"`);
    assert.match(shown[0]!, /````/);
    assert.match(shown[0]!, /送信・script実行・権限変更は行いません/);
    changeDuringShow = true;
    await assert.rejects(browser.select(path), /選び直し/);
    assert.equal(app.session.draft, "変更済み");
    active = false;
    await assert.rejects(browser.select(path), /選び直し/);
  } finally {
    await f.cleanup();
  }
});
