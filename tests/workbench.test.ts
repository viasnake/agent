import assert from "node:assert/strict";
import test from "node:test";
import {
  visibleWidth,
  TuiMainScreen,
  ProcessTerminal,
  CURSOR_MARKER,
} from "@earendil-works/pi-tui";
import { ConversationView, ActivityView } from "../src/tui/workbench.js";
import {
  safeText,
  theme,
  Picker,
  editor,
  frame,
} from "../src/tui/components.js";

test("compact activity prioritizes actual tools and uncertain results on narrow terminals", () => {
  const activity = new ActivityView();
  activity.busy = true;
  activity.run = {
    state: "running",
    tasks: [
      {
        id: "work",
        role: "worker",
        model: "local-worker",
        state: "running",
        objective: "work",
        attempts: 1,
        dependsOn: [],
        write: true,
      },
      {
        id: "review",
        role: "reviewer",
        model: "local-reviewer",
        state: "pending",
        objective: "review",
        attempts: 0,
        dependsOn: ["work"],
        write: false,
      },
    ],
  };
  activity.tool(
    {
      taskId: "work",
      toolId: "1",
      name: "read_file",
      args: { path: "src/日本語.ts\x1b]52;c;secret\x07" },
    },
    true,
  );
  activity.tool(
    {
      taskId: "review",
      toolId: "1",
      name: "read_file",
      args: { path: "tests/config.ts" },
    },
    true,
  );
  activity.tool(
    { taskId: "review", toolId: "1", name: "read_file", failed: true },
    false,
  );
  activity.checks.set("unit", {
    label: "検査 / unit",
    target: "npm test",
    state: "pending",
  });
  let output = safeText(activity.render(80).join("\n"));
  assert.equal(activity.render(80).length, 3);
  assert.match(output, /> 実行中  読み込み.*日本語.ts/);
  assert.match(output, /! 失敗  読み込み.*tests\/config.ts/);
  assert.doesNotMatch(output, /work|review|待機|unit/);
  assert.doesNotMatch(output, /secret/);
  activity.tool(
    { taskId: "work", toolId: "1", name: "read_file", cancelled: true },
    false,
  );
  output = safeText(activity.render(80).join("\n"));
  assert.match(output, /! 結果未確定  読み込み/);
  assert.doesNotMatch(output, /完了/);
  for (const width of [20, 40, 80, 120])
    for (const line of activity.render(width))
      assert.ok(visibleWidth(line) <= width);
  activity.busy = false;
  assert.deepEqual(activity.render(80), []);
  activity.clear();
  assert.equal(activity.tools.size + activity.checks.size, 0);
});

test("picker searches Japanese labels, partial values and descriptions without losing selection", () => {
  let rows = 24;
  const picker = new Picker(
    "操作を検索",
    [
      { value: "diff", label: "変更と差分", description: "/diff" },
      { value: "model", label: "モデルを選択", description: "/model" },
      { value: "status", label: "状態", description: "利用量と接続" },
    ],
    true,
    () => rows,
  );
  let selected = "";
  picker.onSelect = (value) => {
    selected = value;
  };
  picker.handleInput("差分");
  picker.handleInput("\r");
  assert.equal(selected, "diff");
  picker.handleInput("\x15");
  picker.handleInput("odel");
  assert.equal(picker.list.getSelectedItem()?.value, "model");
  picker.handleInput("\x15");
  picker.handleInput("利用量");
  assert.equal(picker.list.getSelectedItem()?.value, "status");
  picker.handleInput("存在しない項目");
  assert.match(
    safeText(picker.render(80).join("\n")),
    /一致する項目がありません/,
  );
  picker.handleInput("\x15");
  picker.handleInput("\x1b[B");
  picker.handleInput("\r");
  assert.equal(selected, "model");
  rows = 11;
  assert.ok(picker.render(40).length <= rows);
  assert.equal(picker.list.getSelectedItem()?.value, "model");
  for (const width of [20, 40, 80, 120])
    for (const line of picker.render(width))
      assert.ok(visibleWidth(line) <= width);
});

test("composer preserves Pi cursor markers, wrapping and complete confirmation paths", () => {
  const tui = new TuiMainScreen(new ProcessTerminal());
  tui.requestRender = () => {};
  const input = editor(tui);
  input.focused = true;
  input.caption = "local-worker · 単独";
  for (const text of ["", "日本語 é\n次の依頼".repeat(5)]) {
    input.setText(text);
    for (const width of [20, 40, 80, 120]) {
      const lines = input.render(width);
      assert.ok(
        lines.some((line) => line.includes(CURSOR_MARKER)),
        "IME cursor position is retained",
      );
      for (const line of lines) assert.ok(visibleWidth(line) <= width);
    }
    assert.equal(input.getText(), text);
  }
  const path = "/projects/long/path/to/the/actual/destination";
  const lines = frame(
    `変更を ${path} へ適用しますか？`,
    ["取消", "実行する"],
    "Esc 戻る",
    40,
  );
  assert.ok(safeText(lines.join("")).replace(/[│ ]/g, "").includes(path));
});

test("conversation layout handles resize, CJK, long messages and color-free terminals", (t) => {
  const original = { NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM };
  t.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.NO_COLOR = "1";
  const view = new ConversationView();
  view.name = "日本語の会話".repeat(15) + "\x1b[2J";
  view.workspace = "/project/日本語";
  for (const width of [20, 40, 80, 120])
    for (const line of view.render(width))
      assert.ok(visibleWidth(line) <= width);
  view.setMessages([
    {
      seq: 1,
      role: "user",
      text: "入力の検証を追加\né と日本語",
      run_id: null,
      at: 1,
    },
    {
      seq: 2,
      role: "assistant",
      text: "**検査済み**\n\n`npm test`\x1b]52;c;secret\x07",
      run_id: null,
      at: 2,
    },
    {
      seq: 3,
      role: "assistant",
      text: "長い出力".repeat(1000),
      run_id: null,
      at: 3,
    },
  ]);
  for (const width of [20, 40, 80, 120]) {
    const lines = view.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    // Pi may terminate a truncated plain line with SGR reset; no styling or
    // controls from the conversation may survive in color-free mode.
    assert.doesNotMatch(
      lines.join("\n").replaceAll("\x1b[0m", ""),
      /\x1b|secret/,
    );
    assert.match(lines.join("\n"), /\/history/);
    assert.match(lines.join("\n"), /é/);
  }
  assert.equal(theme.accent("実行中"), "実行中");
  process.env.NO_COLOR = "";
  process.env.TERM = "dumb";
  assert.equal(theme.error("失敗"), "失敗");
});
