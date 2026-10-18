import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeFile, readFile, access } from "node:fs/promises";
import { stringify } from "yaml";
import { fixture, ScriptedRuntime, gitWorkspace } from "./helpers.js";
import { Sandbox } from "../src/sandbox.js";
import { runProcess, cleanEnvironment } from "../src/process.js";

for (const scenario of [
  "conversation",
  "coding",
  "tmux",
  "exception",
  "editor",
]) {
  test(
    `real PTY: ${scenario}, resize, input, terminal restoration`,
    { skip: process.platform !== "linux", timeout: 40000 },
    async (t) => {
      const f = await fixture(new ScriptedRuntime(async () => "unused"));
      try {
        let cwd = f.root;
        if (
          scenario === "tmux" &&
          !(await access("/usr/bin/tmux").then(
            () => true,
            () => false,
          ))
        ) {
          t.skip("tmux is not installed");
          return;
        }
        if (scenario === "coding") {
          cwd = await gitWorkspace(f.root, { "app.txt": "baseline" });
          f.config.execution.backend = "bubblewrap";
          const probe = await new Sandbox(f.config.execution).probe(cwd);
          if (!probe.ok) {
            if (process.env.AGENT_REQUIRE_SANDBOX === "1")
              assert.fail(probe.detail);
            t.skip(probe.detail);
            return;
          }
          f.config.checks = {
            unit: { command: "sleep 0.2; test -s app.txt", protectedPaths: [] },
          };
        }
        await writeFile(f.p.config, stringify(f.config), { mode: 0o600 });
        const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
        const provider = fileURLToPath(
          new URL("./fixtures/pty-provider.js", import.meta.url),
        );
        const driver = fileURLToPath(
          new URL("../../tests/fixtures/pty-driver.py", import.meta.url),
        );
        const result = await runProcess(
          "python3",
          [driver, process.execPath, cli, provider, f.p.home, scenario],
          {
            cwd,
            env: {
              ...cleanEnvironment,
              TERM: "xterm-256color",
              AGENT_TEST_REQUESTS: join(f.root, "requests.jsonl"),
            },
            timeoutMs: 35000,
            maxBytes: 100000,
          },
        );
        assert.equal(result.code, 0, result.stderr);
        const metrics = JSON.parse(result.stdout);
        t.diagnostic(JSON.stringify(metrics));
        assert.equal(metrics.restored, true);
        if (scenario === "conversation") {
          const messages = f.store.db
            .prepare("SELECT text FROM messages WHERE role='user'")
            .all() as { text: string }[];
          const multiline = messages.find((m) => m.text.includes("貼り付け"));
          assert.ok(multiline?.text.startsWith("先頭続き日本語"));
          assert.ok(
            multiline?.text.includes("\nShift+Enterの改行"),
            JSON.stringify(messages.map((message) => message.text)),
          );
          assert.ok(messages.some((m) => m.text === "短く答えて"));
          const saved = f.store.db
            .prepare(
              "SELECT payload FROM conversations ORDER BY updated_at DESC LIMIT 1",
            )
            .get() as { payload: string };
          assert.equal(JSON.parse(saved.payload).draft, "保存する下書き");
          const trace = await readFile(join(f.root, "requests.jsonl"), "utf8");
          assert.match(trace, /long-output/);
        }
      } finally {
        await f.cleanup();
      }
    },
  );
}
test("non-TTY entry explains the terminal requirement and does not create a run", async () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const result = await runProcess(process.execPath, [cli], {
    env: cleanEnvironment,
    timeoutMs: 10000,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /対話端末/);
});
