import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  codeInfoSchema,
  inspectCode,
  type CodeInfoResult,
} from "../src/code-info.js";
import { readBoundedFile, sha256 } from "../src/util.js";
import { TaskTools } from "../src/tools.js";
import { Sandbox } from "../src/sandbox.js";
import { completed, fixture, ScriptedRuntime } from "./helpers.js";

async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-code-info-"));
  const files: Record<string, string> = {
    "types.ts": "export const count: number = 42;\n",
    "main.ts":
      "import { count } from './types.js';\nconst emoji = '😀'; const use: number = count;\nconst invalid: string = count;\n",
    "plugin.js": "throw new Error('PROJECT_PLUGIN_EXECUTED');\n",
    "tsconfig.json":
      '{"compilerOptions":{"plugins":[{"name":"./plugin.js"}],"paths":{"*": ["/outside/*"]}}}',
  };
  for (const [path, text] of Object.entries(files))
    await writeFile(join(root, path), text);
  return {
    root,
    files,
    query: (
      action: "definition" | "references" | "diagnostics",
      path = "main.ts",
      line = 1,
      column = 1,
      signal = new AbortController().signal,
    ) =>
      inspectCode(
        root,
        { action, path, line, column },
        8_000_000,
        (file) => readBoundedFile(join(root, file), 512_000),
        signal,
      ),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("code information resolves captured symbols with exact UTF-16 positions and explicit non-build diagnostics", async () => {
  const f = await sourceFixture();
  try {
    const line = f.files["main.ts"]!.split("\n")[1]!;
    const result = await f.query(
      "definition",
      "main.ts",
      2,
      line.indexOf("count") + 1,
    );
    assert.equal(result.configuration, "bounded-defaults-not-project-tsconfig");
    assert.equal(result.sourceFiles, 3);
    assert.equal(result.targetSha256, sha256(f.files["main.ts"]!));
    assert.equal(result.truncated, false);
    assert.deepEqual(
      result.results.map((r) => [r.path, r.line, r.column, r.endColumn]),
      [["types.ts", 1, 14, 19]],
    );
    assert.equal(result.results[0]!.sha256, sha256(f.files["types.ts"]!));
    const references = await f.query("references", "types.ts", 1, 14);
    assert.ok(
      references.results.some(
        (r) =>
          r.path === "main.ts" &&
          r.line === 2 &&
          r.column === line.indexOf("count") + 1,
      ),
    );
    assert.ok(
      references.results.some((r) => r.path === "main.ts" && r.line === 3),
    );
    const diagnostics = await f.query("diagnostics");
    assert.ok(diagnostics.results.some((r) => r.code === 2322 && r.line === 3));
    assert.ok(
      diagnostics.limitations.some((value) =>
        value.includes("not a project build"),
      ),
    );
    assert.equal(diagnostics.snapshotSha256, result.snapshotSha256);
    assert.ok(!JSON.stringify(result).includes(f.root));
    for (const [path, text] of Object.entries(f.files))
      assert.equal(await readFile(join(f.root, path), "utf8"), text);
    await assert.rejects(
      () => f.query("definition", "main.ts", 2, 9999),
      /Position must be within/,
    );
  } finally {
    await f.cleanup();
  }
});

test("code information bounds output and rejects unsafe capture, stale bytes and cancellation", async () => {
  const f = await sourceFixture();
  try {
    await writeFile(
      join(f.root, "many.ts"),
      "const marker = 1;\n" + "marker;\n".repeat(110),
    );
    const results = await f.query("references", "many.ts", 1, 7);
    assert.equal(results.results.length, 100);
    assert.equal(results.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(results)) < 36000);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => f.query("diagnostics", "main.ts", 1, 1, controller.signal),
      { name: "AbortError" },
    );
    await assert.rejects(
      () =>
        inspectCode(
          f.root,
          codeInfoSchema.parse({ action: "diagnostics", path: "main.ts" }),
          8_000_000,
          async () => Buffer.from("changed"),
          new AbortController().signal,
        ),
      /changed during capture/,
    );
    await writeFile(join(f.root, "large.ts"), " ".repeat(512_001));
    await assert.rejects(() => f.query("diagnostics"), /512KB/);
    await rm(join(f.root, "large.ts"));
    await symlink(join(f.root, "types.ts"), join(f.root, "link.ts"));
    await assert.rejects(
      () => f.query("diagnostics"),
      /Links and special files/,
    );
    await rm(join(f.root, "link.ts"));
    await writeFile(join(f.root, ".env"), "CANARY=never_read");
    await assert.rejects(
      () => f.query("diagnostics"),
      /Protected or credential-like path/,
    );
    await rm(join(f.root, ".env"));
    await writeFile(join(f.root, "broken.ts"), Buffer.from([0xff]));
    await assert.rejects(() => f.query("diagnostics"), /UTF-8/);
  } finally {
    await f.cleanup();
  }
});

test("read-only task code information uses normal lease, path and audit boundaries without a shell", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const created = await f.harness.create({
      kind: "research",
      objective: "read-only code information",
    });
    const run = f.store.claim(created.id);
    run.access = "read-only";
    const root = join(f.store.runDir(run.id), "work");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "sample.ts"), "const answer: string = 42;\n");
    const task = {
      id: "code-reader",
      role: "worker" as const,
      objective: "inspect",
      dependsOn: [],
      write: false,
      state: "pending" as const,
      attempts: 0,
    };
    const dispatcher = new TaskTools(
      f.config,
      f.store,
      run,
      task,
      root,
      new Sandbox(f.config.execution),
    );
    const tools = dispatcher.all();
    assert.equal(
      tools.some((tool) => tool.name === "shell"),
      false,
    );
    const tool = tools.find((tool) => tool.name === "code_info")!;
    const result = JSON.parse(
      await tool.execute(
        { action: "diagnostics", path: "sample.ts" },
        new AbortController().signal,
      ),
    ) as CodeInfoResult;
    assert.ok(result.results.some((item) => item.code === 2322));
    assert.ok(
      f.store
        .operations(run.id)
        .some(
          (operation) =>
            operation.name === "code_info" && operation.status === "completed",
        ),
    );
    assert.equal(f.store.usage(run.id).requests, 0);
    assert.equal(
      await readFile(join(root, "sample.ts"), "utf8"),
      "const answer: string = 42;\n",
    );
    await assert.rejects(
      () =>
        tool.execute(
          { action: "definition", path: "../outside.ts" },
          new AbortController().signal,
        ),
      /captured TypeScript/,
    );
    f.store.release(run);
    await assert.rejects(
      () =>
        tool.execute(
          { action: "diagnostics", path: "sample.ts" },
          new AbortController().signal,
        ),
      /released/,
    );
  } finally {
    await f.cleanup();
  }
});
