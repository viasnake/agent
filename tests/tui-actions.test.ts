import assert from "node:assert/strict";
import test from "node:test";
import { commandPath } from "../src/tui/actions.js";

test("image staging paths preserve spaces without shell interpretation", () => {
  assert.equal(commandPath('  "資料/画面  1.png"  '), "資料/画面  1.png");
  assert.equal(commandPath("'画面 1.png'"), "画面 1.png");
  assert.equal(commandPath("画面 1.png"), "画面 1.png");
  assert.equal(commandPath("$(command).png"), "$(command).png");
});

test("empty and unterminated image paths produce actionable errors", () => {
  for (const path of ["", "  ", '\"\"', "''", '\"画面.png', "'画面.png"])
    assert.throws(() => commandPath(path), { code: "INPUT_PATH" });
});
