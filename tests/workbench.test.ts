import assert from "node:assert/strict";
import test from "node:test";
import {
  visibleWidth,
  TuiMainScreen,
  TuiAltScreen,
  Text,
  type Terminal,
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
  ResponsiveOverlay,
  WorkbenchLayout,
  ConversationScroll,
} from "../src/tui/components.js";
import {
  connectionProblems,
  failureGuidance,
  doctorSummary,
} from "../src/tui/guidance.js";
import { testConfig } from "./helpers.js";

test("fullscreen uses the viewport width and pins controls while scrolling and resizing", async () => {
  let columns = 157;
  let rows = 51;
  let resize = () => {};
  let input = (_data: string) => {};
  const noop = () => {};
  const terminal: Terminal = {
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    kittyProtocolActive: false,
    start(onInput, onResize) {
      input = onInput;
      resize = onResize;
    },
    stop: noop,
    drainInput: async () => {},
    write: noop,
    moveBy: noop,
    hideCursor: noop,
    showCursor: noop,
    clearLine: noop,
    clearFromCursor: noop,
    clearScreen: noop,
    setTitle: noop,
    setProgress: noop,
    setProgramStatus: noop,
  };
  const tui = new TuiAltScreen(terminal, true);
  const composer = editor(tui);
  composer.setText("日本語の下書き");
  const content = new Text("はじめの会話", 0, 0);
  const ruler = {
    render: (width: number) => ["─".repeat(width)],
    invalidate: noop,
  };
  const layout = new WorkbenchLayout(
    [content],
    [ruler, composer, new Text("操作案内", 0, 0)],
  );
  tui.setLayoutRoot(layout);
  tui.setFocus(composer);
  const frame = async () => {
    tui.requestRender();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lines = tui.getScreenLines();
    assert.equal(lines.length, terminal.rows);
    for (const line of lines) assert.ok(visibleWidth(line) <= terminal.columns);
    assert.match(safeText(lines.at(-1)!), /操作案内/);
    assert.match(safeText(lines.join("\n")), /日本語の下書き/);
    const border = lines.find((line) => line.includes("─"))!;
    assert.equal(visibleWidth(safeText(border).trim()), terminal.columns - 2);
    return safeText(lines.join("\n"));
  };
  tui.start();
  try {
    assert.match(await frame(), /はじめの会話/);
    content.setText(
      Array.from({ length: 150 }, (_, i) => `会話行 ${i}`).join("\n"),
    );
    assert.match(await frame(), /会話行 149/);
    input("\x1b[5~");
    assert.doesNotMatch(await frame(), /会話行 149/);
    assert.equal(layout.scroll.isFollowingEnd, false);
    content.setText(content.render(100).join("\n") + "\n新しい応答");
    assert.doesNotMatch(await frame(), /新しい応答/);
    layout.scroll.scrollToEnd();
    assert.match(await frame(), /新しい応答/);
    for (const nextColumns of [59, 80, 120, 157]) {
      columns = nextColumns;
      rows = nextColumns === 59 ? 29 : 51;
      resize();
      assert.match(await frame(), /新しい応答/);
    }
  } finally {
    tui.stop();
  }
});

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
  assert.equal(
    safeText(input.render(80).join(""))
      .replaceAll(CURSOR_MARKER, "")
      .replace(/[▎\s]/g, ""),
    "",
    "empty composer contains no labels, metadata or hints",
  );
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

test("composer uses Enter to send, Shift+Enter to add a line, and preserves pasted newlines", () => {
  const tui = new TuiMainScreen(new ProcessTerminal());
  tui.requestRender = () => {};
  for (const newline of [
    "\x1bOM",
    "\x1b[13;2u",
    "\x1b[27;2;13~",
    "\x1b[13;2~",
    "\n",
  ]) {
    const input = editor(tui);
    const sent: string[] = [];
    input.onSubmit = (text) => sent.push(text);
    input.handleInput("一行目");
    input.handleInput(newline);
    input.handleInput("\x1b[200~二行目\n三行目\x1b[201~");
    assert.deepEqual(sent, [], "newline and paste must not submit");
    assert.equal(input.getExpandedText(), "一行目\n二行目\n三行目");
    input.handleInput("\r");
    assert.deepEqual(sent, ["一行目\n二行目\n三行目"]);
  }
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
    assert.match(lines.join("\n"), /\/expand/);
    assert.match(lines.join("\n"), /é/);
  }
  assert.equal(theme.accent("実行中"), "実行中");
  process.env.NO_COLOR = "";
  process.env.TERM = "dumb";
  assert.equal(theme.error("失敗"), "失敗");
});

test("open overlays resize without reopening and retain search and focus", () => {
  const picker = new Picker(
    "操作",
    [
      {
        value: "settings",
        label: "接続を設定",
        description: "送信許可・予算を編集",
      },
    ],
    true,
    24,
  );
  const overlay = new ResponsiveOverlay(picker);
  overlay.focused = true;
  overlay.handleInput("接続");
  for (const width of [36, 120, 48, 88]) {
    const lines = overlay.render(width);
    assert.equal(
      Math.max(...lines.map(visibleWidth)),
      Math.min(width, 88) + Math.max(0, Math.floor((width - 88) / 2)),
    );
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.match(safeText(lines.join("\n")), /Esc 戻る/);
    assert.match(safeText(lines.join("\n")), /送信許可/);
  }
  assert.equal(picker.input.getValue(), "接続");
  assert.equal(picker.focused, true);
});

test("model guidance identifies disabled connections without loosening policy", () => {
  const config = testConfig();
  const context = {
    model: "worker",
    dataClass: "private" as const,
    localOnly: false,
  };
  config.connections.local!.enabled = false;
  assert.match(
    failureGuidance("NO_MODEL: unavailable", config, context),
    /接続 local は無効/,
  );
  assert.match(
    failureGuidance("NO_MODEL: unavailable", config, context),
    /接続 local は無効です。\/settings で「local enabled」を検索して確認してください。/,
  );
  assert.equal(config.connections.local!.enabled, false);
  config.connections.local!.enabled = true;
  config.connections.local!.allowedData = ["public"];
  assert.match(
    connectionProblems(config, context).join(),
    /private の送信を許可していません/,
  );
  config.connections.local!.allowedData.push("private");
  assert.deepEqual(connectionProblems(config, context), []);
  assert.match(
    failureGuidance("NO_MODEL: unavailable", config, context),
    /用途・担当・tools/,
  );
});

test("doctor summarizes failures with next actions rather than only JSON", () => {
  const report = doctorSummary({
    node: "v24",
    platform: "linux",
    sandbox: { ok: false, detail: "spawn bwrap ENOENT" },
    connections: [
      {
        name: "local",
        type: "local",
        enabled: false,
        allowedData: ["private"],
        credential: "present",
        budget: "subscription/local",
      },
    ],
    inference: "未実行",
    isolation: "ネットワークなし",
  });
  assert.match(report, /モデルは呼び出していません/);
  assert.match(report, /隔離環境: 要対応/);
  assert.match(report, /Bubblewrap.*Podman/);
  assert.match(report, /ローカル接続（認証の疎通は未確認）/);
  assert.doesNotMatch(report, /起動環境に設定あり/);
});

test("welcome shows only necessary setup and draft restoration", () => {
  const view = new ConversationView();
  view.setup = ["接続の準備が必要です", "1  /settings で接続を登録"];
  view.recent = "/continue 前回の会話へ · 下書きあり";
  const text = safeText(view.render(80).join("\n"));
  assert.doesNotMatch(text, /LOCAL AGENT|何をつくりますか|Ctrl\+P/);
  assert.match(text, /接続の準備/);
  assert.match(text, /\/continue.*下書きあり/);
});

test("conversation keeps a full history page and expands long UTF-8 messages in place", () => {
  const view = new ConversationView();
  const messages = Array.from({ length: 30 }, (_, index) => ({
    seq: index + 1,
    role: "user",
    text: `発言-${index + 1}`,
    run_id: null,
    at: index,
  }));
  messages[29]!.text = "日本語".repeat(900) + "本文末尾";
  view.setMessages(messages);
  const before = safeText(view.render(80).join("\n"));
  assert.match(before, /発言-1 *\n/);
  assert.match(before, /日本語/);
  assert.doesNotMatch(before, /本文末尾|�/);
  assert.equal(view.expand(30), true);
  view.setMessages(messages);
  assert.match(safeText(view.render(80).join("\n")), /本文末尾/);
  assert.equal(view.expand(30), false);
});

test("history prepend preserves the reading anchor without following the tail", () => {
  const scroll = new ConversationScroll(new Text(""), { follow: "end" });
  scroll.updateLayout(100, 20, () => {});
  scroll.scrollToStart();
  let reads = 0;
  scroll.onOlder = (remaining) => {
    reads++;
    scroll.preserveAfterPrepend(200, remaining);
  };
  scroll.scrollBy(-20);
  scroll.updateLayout(300, 20, () => {});
  assert.equal(reads, 1);
  assert.equal(scroll.scrollTop, 180);
  assert.equal(scroll.isFollowingEnd, false);
  scroll.scrollBy(20);
  assert.equal(reads, 1);
});
