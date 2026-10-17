import assert from "node:assert/strict";
import test from "node:test";
import { readdir } from "node:fs/promises";
import { editExternalText } from "../src/external-editor.js";
import { fixture, ScriptedRuntime } from "./helpers.js";

test("external editing uses a private file, returns text and cleans up", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  process.env.LOCAL_AGENT_EDITOR_TEST_CANARY = "not-a-real-credential";
  try {
    const edited = await editExternalText(
      f.p,
      "original",
      [
        process.execPath,
        "-e",
        `const fs = require('node:fs'); const p = process.argv[1]; if (process.env.LOCAL_AGENT_EDITOR_TEST_CANARY || (fs.statSync(p).mode & 0o077)) process.exit(2); fs.writeFileSync(p, '日本語の改訂案');`,
      ],
      1000,
      AbortSignal.timeout(5000),
    );
    assert.equal(edited, "日本語の改訂案");
    assert.ok(
      !(await readdir(f.p.home)).some((name) => name.startsWith("editor-")),
    );
  } finally {
    delete process.env.LOCAL_AGENT_EDITOR_TEST_CANARY;
    await f.cleanup();
  }
});

test("external editing refuses failed or oversized results without leaking scratch files", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  try {
    for (const code of [
      "process.exit(2)",
      "require('node:fs').writeFileSync(process.argv[1], 'x'.repeat(101))",
    ])
      await assert.rejects(
        editExternalText(
          f.p,
          "original",
          [process.execPath, "-e", code],
          100,
          AbortSignal.timeout(5000),
        ),
      );
    assert.ok(
      !(await readdir(f.p.home)).some((name) => name.startsWith("editor-")),
    );
  } finally {
    await f.cleanup();
  }
});
