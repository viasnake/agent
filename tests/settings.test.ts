import assert from "node:assert/strict";
import test from "node:test";
import type { Application } from "../src/application.js";
import { validateConfig } from "../src/config.js";
import { SettingsDialog, type SettingsUi } from "../src/tui/settings.js";
import {
  SettingsEditor,
  type SettingsEdit,
} from "../src/tui/settings-editor.js";
import { safeText } from "../src/tui/components.js";
import { visibleWidth } from "../src/tui/text.js";
import { makeScreen } from "./helpers-tui.js";
import { testConfig } from "./helpers.js";

test("thinking profile edits are staged, cancellable and removable without adding defaults", async () => {
  for (const approve of [false, true]) {
    let config = testConfig();
    let saves = 0;
    const errors: string[] = [];
    const path = (field: string) => JSON.stringify(["models", "worker", field]);
    const edits: SettingsEdit[] = [
      { value: path("reasoning"), text: "true" },
      { value: path("thinkingLevel"), text: "high" },
    ];
    const app = {
      get config() {
        return config;
      },
      session: {
        checks: [],
        dataClass: "private",
        localOnly: false,
        includeUntracked: false,
      },
      async saveConfiguration(raw: unknown) {
        config = validateConfig(raw);
        saves++;
      },
    } as unknown as Application;
    const ui: SettingsUi = {
      edit: async (_title, fields) => {
        assert.ok(fields.some((field) => field.value === path("reasoning")));
        assert.ok(
          fields.some((field) => field.value === path("thinkingLevel")),
        );
        return edits.shift();
      },
      choose: async () => undefined,
      prompt: async () => undefined,
      confirm: async () => approve,
      notify: (message) => errors.push(message),
    };
    await new SettingsDialog(app, ui).open();
    assert.deepEqual(errors, approve ? [] : ["2 件の変更を破棄しました。"]);
    assert.equal(saves, approve ? 1 : 0);
    assert.equal(
      config.models.worker!.thinkingLevel,
      approve ? "high" : undefined,
    );
    assert.equal(config.models.worker!.reasoning, approve ? true : undefined);
    assert.equal("thinkingLevel" in config.models.reviewer!, false);
    if (approve) {
      edits.push(
        { value: path("thinkingLevel"), text: "" },
        { value: path("reasoning"), text: "false" },
      );
      await new SettingsDialog(app, ui).open();
      assert.equal("thinkingLevel" in config.models.worker!, false);
      assert.equal(config.models.worker!.reasoning, false);
      assert.equal(saves, 2);
      assert.deepEqual(errors, []);
    }
  }
});

test("pending edits apply in one batch when closing confirms them", async () => {
  let config = testConfig();
  const edits: SettingsEdit[] = [
    {
      value: JSON.stringify(["connections", "local", "enabled"]),
      text: "false",
    },
    { value: JSON.stringify(["retentionDays"]), text: "50" },
    { value: JSON.stringify(["limits", "maxApiUsd"]), text: "invalid" },
    { value: JSON.stringify(["limits", "maxApiUsd"]), text: "5" },
  ];
  let confirms = 0,
    saves = 0,
    first = true;
  let confirmTitle = "";
  const errors: string[] = [];
  const app = {
    get config() {
      return config;
    },
    session: {
      checks: [],
      dataClass: "private",
      localOnly: false,
      includeUntracked: false,
    },
    async saveConfiguration(raw: unknown) {
      config = validateConfig(raw);
      saves++;
    },
  } as unknown as Application;
  const ui: SettingsUi = {
    edit: async (_title, fields) => {
      if (first) {
        first = false;
        assert.ok(
          fields.some(
            (field) =>
              field.value ===
              JSON.stringify(["connections", "local", "enabled"]),
          ),
        );
      }
      return edits.shift();
    },
    choose: async () => undefined,
    prompt: async () => undefined,
    confirm: async (title) => {
      confirms++;
      confirmTitle = title;
      return true;
    },
    notify: (text) => errors.push(text),
  };
  await new SettingsDialog(app, ui).open();
  assert.equal(config.connections.local!.enabled, false);
  assert.equal(config.retentionDays, 50);
  assert.equal(config.limits.maxApiUsd, 5);
  assert.equal(saves, 1);
  assert.equal(confirms, 1);
  assert.equal(errors.length, 1);
  assert.match(confirmTitle, /connections\.local\.enabled: true → false/);
  assert.match(confirmTitle, /retentionDays: 30 → 50/);
  assert.match(confirmTitle, /limits\.maxApiUsd: 0 → 5/);
});

test("declining the close confirmation discards every pending edit", async () => {
  let config = testConfig();
  const edits: SettingsEdit[] = [
    { value: JSON.stringify(["retentionDays"]), text: "50" },
    { value: JSON.stringify(["limits", "maxApiUsd"]), text: "5" },
  ];
  let confirms = 0,
    saves = 0;
  const notices: string[] = [];
  const app = {
    get config() {
      return config;
    },
    session: {
      checks: [],
      dataClass: "private",
      localOnly: false,
      includeUntracked: false,
    },
    async saveConfiguration(raw: unknown) {
      config = validateConfig(raw);
      saves++;
    },
  } as unknown as Application;
  await new SettingsDialog(app, {
    edit: async () => edits.shift(),
    choose: async () => undefined,
    prompt: async () => undefined,
    confirm: async () => {
      confirms++;
      return false;
    },
    notify: (text) => notices.push(text),
  }).open();
  assert.equal(config.retentionDays, 30);
  assert.equal(config.limits.maxApiUsd, 0);
  assert.equal(saves, 0);
  assert.equal(confirms, 1);
  assert.equal(notices.length, 1);
});

test("edits reverted to their saved value close without confirmation", async () => {
  let config = testConfig();
  const edits: SettingsEdit[] = [
    {
      value: JSON.stringify(["connections", "local", "enabled"]),
      text: "false",
    },
    {
      value: JSON.stringify(["connections", "local", "enabled"]),
      text: "true",
    },
  ];
  let confirms = 0,
    saves = 0;
  const app = {
    get config() {
      return config;
    },
    session: {
      checks: [],
      dataClass: "private",
      localOnly: false,
      includeUntracked: false,
    },
    async saveConfiguration(raw: unknown) {
      config = validateConfig(raw);
      saves++;
    },
  } as unknown as Application;
  await new SettingsDialog(app, {
    edit: async () => edits.shift(),
    choose: async () => undefined,
    prompt: async () => undefined,
    confirm: async () => {
      confirms++;
      return true;
    },
    notify: () => {},
  }).open();
  assert.equal(config.connections.local!.enabled, true);
  assert.equal(saves, 0);
  assert.equal(confirms, 0);
});

test("legacy model config without images can enable the settings toggle", async () => {
  let config = testConfig();
  delete config.models.worker!.images;
  let saves = 0;
  let editCalls = 0;
  const app = {
    get config() {
      return config;
    },
    session: {
      checks: [],
      dataClass: "private",
      localOnly: false,
      includeUntracked: false,
    },
    async saveConfiguration(raw: unknown) {
      config = validateConfig(raw);
      saves++;
    },
  } as unknown as Application;
  await new SettingsDialog(app, {
    edit: async (_title, fields) => {
      if (editCalls++) return undefined;
      const imageToggle = fields.find(
        (field) =>
          field.value === JSON.stringify(["models", "worker", "images"]),
      );
      assert.equal(imageToggle?.current, false);
      return {
        value: JSON.stringify(["models", "worker", "images"]),
        text: "true",
      };
    },
    choose: async () => undefined,
    prompt: async () => undefined,
    confirm: async () => true,
    notify: () => {},
  }).open();
  assert.equal(config.models.worker!.images, true);
  assert.equal(saves, 1);
});

test("added checks join pending config and session changes", async () => {
  let config = testConfig();
  const session = {
    checks: [] as string[],
    dataClass: "private",
    localOnly: false,
    includeUntracked: false,
  };
  const prompts = ["lint", "npm run lint", "src/**"];
  const edits: SettingsEdit[] = [{ value: "check" }];
  let confirms = 0,
    saves = 0,
    sessionSaves = 0,
    editCalls = 0;
  let confirmTitle = "";
  const app = {
    get config() {
      return config;
    },
    session,
    async saveConfiguration(raw: unknown) {
      config = validateConfig(raw);
      saves++;
    },
    save() {
      sessionSaves++;
    },
  } as unknown as Application;
  await new SettingsDialog(app, {
    edit: async (_title, fields) => {
      // After the check is staged the list shows it marked as pending.
      if (++editCalls > 1)
        assert.ok(
          fields.some(
            (field) =>
              field.value === JSON.stringify(["checks", "lint", "command"]) &&
              field.description?.includes("保留"),
          ),
        );
      return edits.shift();
    },
    choose: async () => undefined,
    prompt: async () => prompts.shift(),
    confirm: async (title) => {
      confirms++;
      confirmTitle = title;
      return true;
    },
    notify: () => {},
  }).open();
  assert.equal(config.checks.lint!.command, "npm run lint");
  assert.deepEqual(config.checks.lint!.protectedPaths, ["src/**"]);
  assert.deepEqual(session.checks, ["lint"]);
  assert.equal(saves, 1);
  assert.equal(sessionSaves, 1);
  assert.equal(confirms, 1);
  assert.match(confirmTitle, /checks\.lint:/);
  assert.match(confirmTitle, /session\.checks:/);
});

test("existing session cannot broaden disclosure or drop local-only protection", async () => {
  const session = {
    checks: [],
    dataClass: "restricted",
    localOnly: true,
    includeUntracked: false,
    latestRunId: "run",
  };
  const edits = [
    { value: JSON.stringify(["session", "dataClass"]), text: "public" },
    { value: JSON.stringify(["session", "localOnly"]), text: "false" },
  ];
  const errors: string[] = [];
  const app = {
    config: testConfig(),
    session,
    save() {
      assert.fail("must not save");
    },
  } as unknown as Application;
  await new SettingsDialog(app, {
    edit: async () => edits.shift(),
    choose: async () => undefined,
    prompt: async () => undefined,
    confirm: async () => {
      assert.fail("must reject before confirmation");
    },
    notify: (text) => errors.push(text),
  }).open();
  assert.equal(errors.length, 2);
  assert.equal(session.dataClass, "restricted");
  assert.equal(session.localOnly, true);
});

test("session field edits save separately from config edits", async () => {
  let config = testConfig();
  const session = {
    checks: [] as string[],
    dataClass: "private",
    localOnly: false,
    includeUntracked: false,
  };
  const edits: SettingsEdit[] = [
    { value: JSON.stringify(["retentionDays"]), text: "90" },
    { value: JSON.stringify(["session", "dataClass"]), text: "restricted" },
    { value: JSON.stringify(["session", "checks"]), text: "" },
  ];
  let saves = 0,
    sessionSaves = 0;
  const app = {
    get config() {
      return config;
    },
    session,
    async saveConfiguration(raw: unknown) {
      config = validateConfig(raw);
      saves++;
    },
    save() {
      sessionSaves++;
    },
  } as unknown as Application;
  await new SettingsDialog(app, {
    edit: async () => edits.shift(),
    choose: async () => undefined,
    prompt: async () => undefined,
    confirm: async () => true,
    notify: () => {},
  }).open();
  assert.equal(config.retentionDays, 90);
  assert.equal(session.dataClass, "restricted");
  assert.equal(saves, 1);
  assert.equal(sessionSaves, 1);
});

test("settings inline edit retains search, cancels one level and fits narrow CJK terminals", async () => {
  const screen = await makeScreen(80, 29);
  const position = { query: "予算", selected: "budget" };
  const panel = new SettingsEditor(
    screen.renderer,
    "設定",
    [
      {
        value: "budget",
        label: "予算",
        current: "100",
        description: "limits.maxApiUsd",
      },
    ],
    position,
  );
  let submitted: SettingsEdit | undefined;
  panel.onSubmit = (edit) => {
    submitted = edit;
  };
  panel.focus();
  panel.handleInput("\r");
  assert.match(
    safeText((await screen.frame(panel, 59, 29)).join("\n")),
    /値:.*100/,
  );
  assert.equal(panel.cancel(), true);
  assert.equal(submitted, undefined);
  assert.equal(panel.picker.input.value, "予算");
  panel.handleInput("\r");
  panel.handleInput("\x05");
  panel.handleInput("\x15");
  panel.handleInput("200");
  panel.handleInput("\r");
  assert.deepEqual(submitted, { value: "budget", text: "200" });
  for (const width of [20, 59, 157]) {
    for (const line of await screen.frame(panel, width, 29))
      assert.ok(visibleWidth(line) <= width);
  }
  await screen.dispose();
});
