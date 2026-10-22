import assert from "node:assert/strict";
import test from "node:test";
import { TextRenderable } from "@opentui/core";
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
  visibleWidth,
} from "../src/tui/components.js";
import {
  connectionProblems,
  failureGuidance,
  doctorSummary,
} from "../src/tui/guidance.js";
import { fixture, ScriptedRuntime, testConfig } from "./helpers.js";
import { TerminalApp } from "../src/tui/app.js";
import { Application } from "../src/application.js";
import { makeScreen, chunksToText } from "./helpers-tui.js";

test("saved drafts survive slash commands and selecting the same conversation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const runtime = new ScriptedRuntime(async () => {
    throw new Error("Draft operations must not call a model");
  });
  const f = await fixture(runtime);
  const screen = await makeScreen(80, 24);
  const app = new Application(f.config, f.p, f.store, f.root);
  const terminal = new TerminalApp(undefined, screen.renderer);
  terminal.tui.requestRender = () => {};
  terminal.app = app;
  app.on("event", (event) => terminal["event"](event));
  try {
    await app.initialize();
    const draft =
      '売上を確認してください @"sales.csv::rows=2-3" OFFLINE_EDITOR_OK\n';
    terminal.input.setText(draft);
    t.mock.timers.tick(250);
    terminal["key"]("\x03");
    t.mock.timers.tick(250);
    assert.equal(terminal.input.getExpandedText(), "");
    assert.equal(app.conversations.get(app.session.id).draft, draft);

    terminal.input.setText("/keys palette ctrl+g");
    await terminal["submit"]("/keys palette ctrl+g");
    t.mock.timers.tick(250);
    assert.equal(app.conversations.get(app.session.id).draft, draft);

    terminal["choose"] = async () => {
      t.mock.timers.tick(500);
      return app.session.id;
    };
    terminal.input.setText("/sessions");
    await terminal["submit"]("/sessions");
    t.mock.timers.tick(250);
    assert.equal(terminal.input.getExpandedText(), draft);
    assert.equal(app.conversations.get(app.session.id).draft, draft);
    assert.equal(runtime.requests.length, 0);
    assert.deepEqual(f.store.list(), []);

    terminal.input.setText("");
    t.mock.timers.tick(250);
    assert.equal(app.conversations.get(app.session.id).draft, "");
  } finally {
    await app.close();
    await screen.dispose();
    await f.cleanup();
  }
});

test("palette navigation saves the current draft before its debounce expires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  const screen = await makeScreen(80, 24);
  const app = new Application(f.config, f.p, f.store, f.root);
  const terminal = new TerminalApp(undefined, screen.renderer);
  terminal.tui.requestRender = () => {};
  terminal.app = app;
  app.on("event", (event) => terminal["event"](event));
  try {
    await app.initialize();
    const previous = app.session.id;
    terminal.input.setText("まだ自動保存されていない下書き");
    await terminal["command"]("new");
    t.mock.timers.tick(250);
    assert.equal(
      app.conversations.get(previous).draft,
      "まだ自動保存されていない下書き",
    );
    assert.notEqual(app.session.id, previous);
    assert.equal(app.session.draft, "");
  } finally {
    await app.close();
    await screen.dispose();
    await f.cleanup();
  }
});

test("external editing does not copy the TUI draft into the shell buffer", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  const screen = await makeScreen(80, 24);
  const app = new Application(f.config, f.p, f.store, f.root);
  const terminal = new TerminalApp(undefined, screen.renderer);
  const calls: string[] = [];
  terminal.tui.suspendScreen = async () => {
    calls.push("suspend");
  };
  terminal.tui.resumeScreen = async () => {
    calls.push("resume");
  };
  terminal.app = app;
  terminal["preferences"].editor = [
    process.execPath,
    "-e",
    "require('node:fs').appendFileSync(process.argv[1], ' edited')",
  ];
  try {
    await app.initialize();
    const draft = "SHELL_MUST_NOT_CONTAIN_THIS_DRAFT";
    terminal.input.setText(draft);
    await terminal["externalEditor"](false);
    assert.equal(terminal.input.getExpandedText(), `${draft} edited`);
    assert.equal(app.session.draft, `${draft} edited`);
    assert.deepEqual(calls, ["suspend", "resume"]);
  } finally {
    if (terminal["draftTimer"]) clearTimeout(terminal["draftTimer"]);
    if (terminal["renderTimer"]) clearTimeout(terminal["renderTimer"]);
    await screen.dispose();
    await app.close();
    await f.cleanup();
  }
});

test("fullscreen uses the viewport width and pins controls while scrolling and resizing", async () => {
  const screen = await makeScreen(157, 51);
  const composer = editor(screen.renderer);
  composer.setText("日本語の下書き");
  const content = new TextRenderable(screen.renderer, {
    content: "はじめの会話",
  });
  const ruler = new TextRenderable(screen.renderer, {
    content: "─".repeat(300),
    wrapMode: "none",
  });
  const layout = new WorkbenchLayout(
    screen.renderer,
    [content],
    [
      ruler,
      composer,
      new TextRenderable(screen.renderer, { content: "操作案内" }),
    ],
  );
  const frame = async () => {
    const lines = await screen.frame(layout);
    assert.equal(lines.length, screen.renderer.height);
    for (const line of lines)
      assert.ok(visibleWidth(line) <= screen.renderer.width);
    assert.match(safeText(lines.at(-1)!), /操作案内/);
    assert.match(safeText(lines.join("\n")), /日本語の下書き/);
    const border = lines.find((line) => /─{4,}/.test(line))!;
    assert.equal(
      visibleWidth(safeText(border).trim()),
      screen.renderer.width - 2,
    );
    return safeText(lines.join("\n"));
  };
  try {
    assert.match(await frame(), /はじめの会話/);
    let body = Array.from({ length: 150 }, (_, i) => `会話行 ${i}`).join("\n");
    content.content = body;
    assert.match(await frame(), /会話行 149/);
    layout.scroll.scrollBy(-30);
    assert.doesNotMatch(await frame(), /会話行 149/);
    assert.equal(layout.scroll.isFollowingEnd, false);
    body = `${body}\n新しい応答`;
    content.content = body;
    assert.doesNotMatch(await frame(), /新しい応答/);
    layout.scroll.scrollToEnd();
    assert.match(await frame(), /新しい応答/);
    for (const nextColumns of [59, 80, 120, 157]) {
      const nextRows = nextColumns === 59 ? 29 : 51;
      screen.resize(nextColumns, nextRows);
      assert.match(await frame(), /新しい応答/);
    }
  } finally {
    await screen.dispose();
  }
});

test("compact activity prioritizes actual tools and uncertain results on narrow terminals", async () => {
  const screen = await makeScreen(80, 24);
  const activity = new ActivityView(screen.renderer);
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
  let output = safeText(chunksToText(activity.lines()));
  assert.equal(activity.lines().length, 3);
  assert.match(output, /> 実行中  読み込み.*日本語.ts/);
  assert.match(output, /! 失敗  読み込み.*tests\/config.ts/);
  assert.doesNotMatch(output, /work|review|待機|unit/);
  assert.doesNotMatch(output, /secret/);
  activity.tool(
    { taskId: "work", toolId: "1", name: "read_file", cancelled: true },
    false,
  );
  output = safeText(chunksToText(activity.lines()));
  assert.match(output, /! 結果未確定  読み込み/);
  assert.doesNotMatch(output, /完了/);
  for (const width of [20, 40, 80, 120]) {
    const lines = await screen.frame(activity, width, 24);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  activity.busy = false;
  assert.deepEqual(activity.lines(), []);
  activity.clear();
  assert.equal(activity.tools.size + activity.checks.size, 0);
  await screen.dispose();
});

test("picker searches Japanese labels, partial values and descriptions without losing selection", async () => {
  const screen = await makeScreen(80, 24);
  const picker = new Picker(
    screen.renderer,
    "操作を検索",
    [
      { value: "diff", label: "変更と差分", description: "/diff" },
      { value: "model", label: "モデルを選択", description: "/model" },
      { value: "status", label: "状態", description: "利用量と接続" },
    ],
    true,
  );
  let selected = "";
  picker.onSelect = (item) => {
    selected = item?.value ?? "";
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
    safeText((await screen.frame(picker)).join("\n")),
    /一致する項目がありません/,
  );
  picker.handleInput("\x15");
  picker.handleInput("\x1b[B");
  picker.handleInput("\r");
  assert.equal(selected, "model");
  assert.ok(
    (await screen.frame(picker, 40, 11)).every(
      (line) => visibleWidth(line) <= 40,
    ),
  );
  assert.equal(picker.list.getSelectedItem()?.value, "model");
  for (const width of [20, 40, 80, 120])
    for (const line of await screen.frame(picker, width, 24))
      assert.ok(visibleWidth(line) <= width);
  await screen.dispose();
});

test("composer keeps wrapping consistent and confirms complete text round trips", async () => {
  const screen = await makeScreen(80, 24);
  const input = editor(screen.renderer);
  input.focus();
  const empty = await screen.frame(input);
  assert.equal(
    safeText(empty.join("")).replace(/[\s]/g, ""),
    "",
    "empty composer contains no labels, metadata or hints",
  );
  for (const text of ["", "日本語 é\n次の依頼".repeat(5)]) {
    input.setText(text);
    for (const width of [20, 40, 80, 120]) {
      const lines = await screen.frame(input, width, 24);
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
  await screen.dispose();
});

test("composer uses Enter to send, Shift+Enter to add a line, and preserves pasted newlines", async () => {
  const screen = await makeScreen(80, 24);
  for (const newline of [
    "\x1bOM",
    "\x1b[13;2u",
    "\x1b[27;2;13~",
    "\x1b[13;2~",
  ]) {
    const input = editor(screen.renderer);
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
  await screen.dispose();
});

test("Ctrl+J is consumed before editors and dialogs, without swallowing pasted newlines", async () => {
  const screen = await makeScreen(80, 24);
  const app = new TerminalApp(undefined, screen.renderer);
  app.tui.requestRender = () => {};
  app.input.setText("日本語");
  for (const key of ["\n", "\x1b[106;5u", "\x1b[27;5;106~"]) {
    assert.deepEqual(app["key"](key), { consume: true });
  }
  assert.equal(app.input.getText(), "日本語");
  assert.equal(app["key"]("\x1b[200~一行目\n二行目\x1b[201~"), undefined);
  assert.equal(app["key"]("\x1b[13;2u"), undefined);
  app.input.setText("日本語");
  app.input.focus();
  assert.equal(app.input.getExpandedText(), "日本語");
  await screen.dispose();
});

test("conversation layout handles resize, CJK, long messages and untrusted content", async () => {
  const screen = await makeScreen(80, 24);
  const view = new ConversationView(screen.renderer);
  view.name = "日本語の会話".repeat(15) + "\x1b[2J";
  view.workspace = "/project/日本語";
  for (const width of [20, 40, 80, 120])
    for (const line of await screen.frame(view, width, 24))
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
    // 実アプリでは ConversationScroll 内に置くため、内容高ぶんの
    // 高さでフレームして全体をレンダリングする。
    const lines = await screen.frame(view, width, 400);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    // 文字グリッドはプレーンテキストのため制御シーケンスは混入しない
    assert.doesNotMatch(lines.join("\n"), /\x1b|secret/);
    assert.match(lines.join("\n"), /\/expand/);
    assert.match(lines.join("\n"), /é/);
  }
  // theme はスタイルチャンクを返し、テキストはそのまま保持される
  assert.equal(theme.accent("実行中").text, "実行中");
  assert.equal(theme.error("失敗").text, "失敗");
  await screen.dispose();
});

test("open overlays resize without reopening and retain search and focus", async () => {
  const screen = await makeScreen(80, 24);
  const picker = new Picker(
    screen.renderer,
    "操作",
    [
      {
        value: "settings",
        label: "接続を設定",
        description: "送信許可・予算を編集",
      },
    ],
    true,
  );
  const overlay = new ResponsiveOverlay(screen.renderer, picker);
  picker.focus();
  picker.handleInput("接続");
  for (const width of [36, 120, 48, 88]) {
    const lines = await screen.frame(overlay, width, 24);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.match(safeText(lines.join("\n")), /Esc 戻る/);
    assert.match(safeText(lines.join("\n")), /送信許可/);
  }
  assert.equal(picker.input.value, "接続");
  assert.equal(picker.focused, true);
  await screen.dispose();
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
  assert.match(report, /Bubblewrap/);
  assert.match(report, /ローカル接続（認証の疎通は未確認）/);
  assert.doesNotMatch(report, /起動環境に設定あり/);
});

test("welcome shows only necessary setup and draft restoration", async () => {
  const screen = await makeScreen(80, 24);
  const view = new ConversationView(screen.renderer);
  view.setup = ["接続の準備が必要です", "1  /settings で接続を登録"];
  view.recent = "/continue 前回の会話へ · 下書きあり";
  view.setMessages([]);
  const text = safeText((await screen.frame(view)).join("\n"));
  assert.doesNotMatch(text, /LOCAL AGENT|何をつくりますか|Ctrl\+P/);
  assert.match(text, /接続の準備/);
  assert.match(text, /\/continue.*下書きあり/);
  await screen.dispose();
});

test("conversation keeps a full history page and expands long UTF-8 messages in place", async () => {
  const screen = await makeScreen(80, 200);
  const view = new ConversationView(screen.renderer);
  const messages = Array.from({ length: 30 }, (_, index) => ({
    seq: index + 1,
    role: "user",
    text: `発言-${index + 1}`,
    run_id: null,
    at: index,
  }));
  messages[29]!.text = "日本語".repeat(900) + "本文末尾";
  view.setMessages(messages);
  const before = safeText((await screen.frame(view)).join("\n"));
  assert.match(before, /発言-1 *\n/);
  assert.match(before, /日本語/);
  assert.doesNotMatch(before, /本文末尾|�/);
  assert.equal(view.expand(30), true);
  view.setMessages(messages);
  assert.match(safeText((await screen.frame(view)).join("\n")), /本文末尾/);
  assert.equal(view.expand(30), false);
  await screen.dispose();
});

test("history prepend preserves the reading anchor without following the tail", async () => {
  const screen = await makeScreen(100, 20);
  const scroll = new ConversationScroll(screen.renderer);
  scroll.height = 20;
  const body = new TextRenderable(screen.renderer, {
    content: Array.from({ length: 100 }, (_, i) => `行 ${i}`).join("\n"),
  });
  scroll.content.add(body);
  await screen.frame(scroll);
  scroll.scrollToStart();
  let reads = 0;
  scroll.onOlder = (remaining) => {
    reads++;
    scroll.markPrepend();
    body.content = Array.from({ length: 300 }, (_, i) => `行 ${i}`).join("\n");
    scroll.preserveAfterPrepend(remaining);
  };
  scroll.scrollBy(-20);
  await screen.renderOnce();
  assert.equal(reads, 1);
  assert.equal(scroll.scrollTop, 180);
  assert.equal(scroll.isFollowingEnd, false);
  scroll.scrollBy(20);
  assert.equal(reads, 1);
  await screen.dispose();
});
