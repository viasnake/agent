import assert from "node:assert/strict";
import test from "node:test";
import { actionFor } from "../src/tui/actions.js";
import {
  bindingKey,
  loadPreferences,
  parsePreferences,
  savePreferences,
} from "../src/tui/preferences.js";
import { fixture, ScriptedRuntime } from "./helpers.js";

test("terminal key overrides persist without altering provider configuration", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  try {
    const initial = await loadPreferences(f.p);
    assert.deepEqual(initial.keys, {});
    const saved = await savePreferences(f.p, {
      ...initial,
      keys: { palette: ["ctrl+g"] },
      editor: ["vi", "-n"],
    });
    assert.deepEqual(await loadPreferences(f.p), saved);
    assert.equal(actionFor("\x07", saved.keys), "palette");
    assert.equal(actionFor("\x10", saved.keys), undefined);
    assert.equal(actionFor("\x10"), "palette");
    assert.equal(bindingKey("shift+ctrl+g"), "ctrl+shift+g");
  } finally {
    await f.cleanup();
  }
});

test("key configuration rejects collisions, input hazards and unknown actions", () => {
  for (const key of [
    "enter",
    "a",
    "ctrl+j",
    "ctrl+ctrl+g",
    "shift+enter",
    "ctrl+m",
    "ctrl+i",
    "ctrl+h",
    "exec+g",
  ])
    assert.throws(() => bindingKey(key));
  assert.throws(() =>
    parsePreferences({ schemaVersion: 1, keys: { palette: ["ctrl+l"] } }),
  );
  assert.throws(() =>
    parsePreferences({ schemaVersion: 1, keys: { typo: ["ctrl+g"] } }),
  );
  assert.deepEqual(
    parsePreferences({ schemaVersion: 1, keys: { palette: [] } }).keys.palette,
    [],
  );
});
