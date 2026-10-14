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
import { visibleWidth } from "@earendil-works/pi-tui";
import { testConfig } from "./helpers.js";

test("settings cancel does not leak changes, supports consecutive edits and rejects invalid values", async () => {
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
    saves = 0;
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
      assert.ok(
        fields.some(
          (field) =>
            field.value === JSON.stringify(["connections", "local", "enabled"]),
        ),
      );
      return edits.shift();
    },
    choose: async () => undefined,
    prompt: async () => undefined,
    confirm: async () => ++confirms !== 1,
    notify: (text) => errors.push(text),
  };
  await new SettingsDialog(app, ui).open();
  assert.equal(config.connections.local!.enabled, true);
  assert.equal(config.retentionDays, 50);
  assert.equal(config.limits.maxApiUsd, 5);
  assert.equal(saves, 2);
  assert.equal(confirms, 2);
  assert.equal(errors.length, 1);
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

test("settings inline edit retains search, cancels one level and fits narrow CJK terminals", () => {
  const position = { query: "予算", selected: "budget" };
  const panel = new SettingsEditor(
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
    () => 29,
  );
  let submitted: SettingsEdit | undefined;
  panel.onSubmit = (edit) => {
    submitted = edit;
  };
  panel.focused = true;
  panel.handleInput("\r");
  assert.match(safeText(panel.render(59).join("\n")), /値:.*100/);
  assert.equal(panel.cancel(), true);
  assert.equal(submitted, undefined);
  assert.equal(panel.picker.input.getValue(), "予算");
  panel.handleInput("\r");
  panel.handleInput("\x05");
  panel.handleInput("\x15");
  panel.handleInput("200");
  panel.handleInput("\r");
  assert.deepEqual(submitted, { value: "budget", text: "200" });
  for (const width of [20, 59, 157]) {
    for (const line of panel.render(width))
      assert.ok(visibleWidth(line) <= width);
  }
});
