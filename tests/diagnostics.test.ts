import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { chmod, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { Application } from "../src/application.js";
import { paths } from "../src/config.js";
import { previewDiagnostics, writeDiagnostics } from "../src/diagnostics.js";
import { runProcess } from "../src/process.js";
import { DiagnosticsBrowser } from "../src/tui/diagnostics-browser.js";
import { commands } from "../src/tui/actions.js";
import { fixture, gitWorkspace, ScriptedRuntime } from "./helpers.js";

const canary = "PRIVATE_DIAGNOSTIC_CANARY_938103";
const runtime = () =>
  new ScriptedRuntime(async () => assert.fail("Diagnostics must not infer"));

test("diagnostics projects only closed vocabularies and accurately labels bounded metadata samples", async () => {
  const f = await fixture(runtime());
  try {
    f.config.connections.local!.account = canary;
    f.config.connections.local!.endpoint += "/" + canary;
    f.config.connections.local!.secretEnv = canary;
    f.config.models.worker!.id = canary;
    f.config.checks[canary] = { command: canary, protectedPaths: [canary] };
    await writeFile(f.p.config, stringify(f.config), { mode: 0o600 });
    await writeFile(join(f.p.auth, "credentials.json"), canary, {
      mode: 0o600,
    });
    f.store.transaction(() => {
      const run = f.store.db.prepare(
        "INSERT INTO runs(id,state,payload) VALUES(?,?,?)",
      );
      const operation = f.store.db.prepare(
        "INSERT INTO operations(id,run_id,generation,task_id,name,args_hash,status,result) VALUES(?,?,0,?,?,?,?,?)",
      );
      const request = f.store.db.prepare(
        "INSERT INTO requests(id,run_id,connection,model,quota_scope,at,reserved_usd,status) VALUES(?,?,?,?,?,0,0,?)",
      );
      for (let index = 0; index < 1001; index++) {
        const id = canary + index;
        run.run(id, index === 1000 ? canary : "succeeded", canary);
        operation.run(
          id,
          id,
          canary,
          canary,
          canary,
          index === 1000 ? canary : "completed",
          canary,
        );
        request.run(
          id,
          id,
          canary,
          canary,
          canary,
          index === 1000 ? canary : "reserved",
        );
      }
      for (let index = 0; index < 42; index++)
        f.store.event(canary + "0", index % 2 ? canary : "artifact_saved", {
          [canary]: canary,
        });
    });
    const preview = await previewDiagnostics(f.p);
    assert.equal(preview.text.includes(canary), false);
    assert.equal(preview.text.includes(f.root), false);
    const report = JSON.parse(preview.text);
    assert.equal(report.probes, "not-run");
    assert.equal(report.configuration.models, 2);
    assert.equal(report.configuration.checks, 1);
    assert.deepEqual(
      report.configuration.enabledConnections.find(
        (v: { category: string }) => v.category === "local",
      ),
      { category: "local", count: 1 },
    );
    for (const [name, expected] of [
      ["runs", "succeeded"],
      ["operations", "completed"],
      ["requests", "reserved"],
    ]) {
      const sample = report.storage[name!];
      assert.equal(sample.scanned, 1000);
      assert.equal(sample.truncated, true);
      assert.equal(
        sample.counts.find((v: { category: string }) => v.category === expected)
          .count,
        999,
      );
      assert.equal(
        sample.counts.find((v: { category: string }) => v.category === "other")
          .count,
        1,
      );
    }
    assert.equal(report.storage.events.truncated, true);
    assert.deepEqual(
      report.storage.events.categories,
      Array.from({ length: 40 }, (_, index) =>
        index % 2 ? "other" : "artifact_saved",
      ),
    );
    assert.deepEqual(
      JSON.parse((await previewDiagnostics(f.p, f.config)).text),
      report,
    );
    const output = join(f.root, "diagnostics.json");
    writeDiagnostics(f.p, preview, output);
    assert.equal(await readFile(output, "utf8"), preview.text);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(
      await readFile(join(f.p.auth, "credentials.json"), "utf8"),
      canary,
    );
  } finally {
    await f.cleanup();
  }
});

test("diagnostics remains useful for missing or broken storage without creating home or exposing errors", async () => {
  const f = await fixture(runtime());
  try {
    const missing = paths(join(f.root, canary));
    const preview = await previewDiagnostics(missing);
    assert.deepEqual(JSON.parse(preview.text).storage, {
      status: "unavailable",
    });
    assert.deepEqual(JSON.parse(preview.text).configuration, {
      status: "unavailable",
    });
    assert.equal(existsSync(missing.home), false);
    writeDiagnostics(missing, preview, join(f.root, "missing.json"));
    await writeFile(f.p.config, canary, { mode: 0o600 });
    f.store.db.exec("PRAGMA user_version=99");
    const broken = await previewDiagnostics(f.p);
    assert.equal(broken.text.includes(canary), false);
    assert.deepEqual(JSON.parse(broken.text).storage, {
      status: "unavailable",
    });
    assert.deepEqual(JSON.parse(broken.text).configuration, {
      status: "unavailable",
    });
    assert.equal(
      f.store.db.prepare("PRAGMA user_version").get()!.user_version,
      99,
    );
  } finally {
    await f.cleanup();
  }
});

test("diagnostic export rejects forged previews, existing targets, links and Agent-internal paths", async () => {
  const f = await fixture(runtime());
  try {
    const preview = await previewDiagnostics(f.p, f.config);
    const target = join(f.root, "existing.json");
    await writeFile(target, canary, { mode: 0o600 });
    assert.throws(
      () => writeDiagnostics(f.p, { text: canary }, join(f.root, "forged")),
      { code: "DIAGNOSTIC_PREVIEW" },
    );
    assert.throws(() => writeDiagnostics(f.p, preview, target), {
      code: "DIAGNOSTIC_WRITE",
    });
    const link = join(f.root, "link");
    await symlink(target, link);
    assert.throws(() => writeDiagnostics(f.p, preview, link), {
      code: "DIAGNOSTIC_WRITE",
    });
    assert.throws(
      () => writeDiagnostics(f.p, preview, join(f.p.home, "diagnostics.json")),
      { code: "DIAGNOSTIC_WRITE" },
    );
    assert.equal(existsSync(join(f.p.home, "diagnostics.json")), false);
    assert.equal(await readFile(target, "utf8"), canary);
    await chmod(f.root, 0o777);
    assert.throws(
      () => writeDiagnostics(f.p, preview, join(f.root, "unsafe")),
      { code: "DIAGNOSTIC_WRITE" },
    );
    await chmod(f.root, 0o700);
  } finally {
    await f.cleanup();
  }
});

test("diagnostic CLI is preview-first even without initialized storage", async () => {
  const f = await fixture(runtime());
  try {
    const home = join(f.root, canary);
    const output = join(f.root, "cli.json");
    const command = [
      fileURLToPath(new URL("../src/cli.js", import.meta.url)),
      "--home",
      home,
      "--json",
      "diagnostics",
      output,
    ];
    const invoke = (extra: string[] = []) =>
      runProcess(process.execPath, [...command, ...extra], {
        env: { ...process.env, [canary]: canary },
        timeoutMs: 30000,
        maxBytes: 30000,
      });
    const preview = await invoke();
    assert.equal(preview.code, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).written, false);
    assert.equal(preview.stdout.includes(canary), false);
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(home), false);
    const written = await invoke(["--write"]);
    assert.equal(written.code, 0, written.stderr);
    assert.equal(JSON.parse(written.stdout).written, true);
    assert.deepEqual(
      JSON.parse(await readFile(output, "utf8")),
      JSON.parse(written.stdout).report,
    );
    assert.equal(existsSync(home), false);
    const refused = await invoke(["--write"]);
    assert.notEqual(refused.code, 0);
    assert.equal(refused.stderr.includes(canary), false);
  } finally {
    await f.cleanup();
  }
});

test("diagnostic dialog cancels at each step and exports exactly the displayed immutable snapshot", async () => {
  const f = await fixture(runtime());
  const workspace = await gitWorkspace(f.root, { "README.md": canary });
  const app = new Application(f.config, f.p, f.store, workspace, async () =>
    assert.fail("No runtime for diagnostics"),
  );
  await app.initialize();
  try {
    assert.ok(commands.some((command) => command.name === "diagnostics"));
    const output = join(f.root, "dialog.json");
    for (const cancel of ["prompt", "preview", "confirm", "none"]) {
      let shown = "";
      let saved = false;
      await new DiagnosticsBrowser(app, {
        prompt: async () => (cancel === "prompt" ? undefined : output),
        show: async (text) => {
          shown = text.match(/```json\n([\s\S]*)```/)![1]!;
          assert.equal(shown.includes(canary), false);
          return cancel !== "preview";
        },
        confirm: async () => {
          // The exported diagnostic is the reviewed capture, not a fresh DB read.
          f.store.db.exec("PRAGMA user_version=99");
          return cancel !== "confirm";
        },
        notice: () => {
          saved = true;
        },
      }).save();
      assert.equal(saved, cancel === "none");
      assert.equal(existsSync(output), cancel === "none");
      if (cancel === "none")
        assert.equal(await readFile(output, "utf8"), shown);
      f.store.db.exec("PRAGMA user_version=4");
    }
  } finally {
    await app.close();
    await f.cleanup();
  }
});
