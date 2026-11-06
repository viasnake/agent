import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, jobInput } from "./support.js";
import { GithubConnector } from "../src/integrations/github.js";
import type { GithubTransport } from "../src/integrations/github.js";
import { AppError } from "../src/security.js";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Storage } from "@earendil-works/pi-durable";
import { createServer as apiServer } from "../src/server.js";

async function crashChild(mode: string, root: string, value = "") {
  const child = fork(
    resolve(".test-dist/tests/crash-child.js"),
    [mode, root, value],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const messages: { stage: string; id?: string; error?: string }[] = [];
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("message", (message) =>
    messages.push(message as { stage: string; id?: string; error?: string }),
  );
  const wait = async (stage: string) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const match = messages.find((message) => message.stage === stage);
      if (match) return match;
      if (
        messages.some((message) => message.stage === "error") ||
        child.exitCode !== null
      )
        throw new Error(`${JSON.stringify(messages)} ${stderr}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error(`Child timeout: ${stage} ${stderr}`);
  };
  await wait("ready");
  return {
    child,
    wait,
    kill: async () => {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    },
  };
}

test("R01: actual SIGKILL before/after SQLite admission commit never duplicates an accepted job", async () => {
  for (const phase of ["before-commit", "after-commit"]) {
    const root = await mkdtemp(join(tmpdir(), "agent-admission-crash-")),
      requestId = randomUUID();
    const process = await crashChild(phase, root);
    process.child.send({ requestId });
    await process.wait(phase);
    await process.kill();
    const { service } = await fixture([], { noModel: true, dataRoot: root });
    try {
      assert.equal(
        (await service.snapshot()).jobs.length,
        phase === "before-commit" ? 0 : 1,
      );
      const result = await service.create(jobInput({ requestId }));
      assert.equal(
        (await service.create(jobInput({ requestId }))).id,
        result.id,
      );
      assert.equal((await service.snapshot()).jobs.length, 1);
    } finally {
      await service.close();
    }
  }
});

test("R02 R03 R14: actual SIGKILL during inference or unsafe shell retains limits and blocks replay", async () => {
  for (const mode of ["model", "shell"]) {
    const root = await mkdtemp(join(tmpdir(), "agent-execution-crash-")),
      requestId = randomUUID();
    const process = await crashChild(mode, root);
    process.child.send({ requestId });
    const created = await process.wait("created");
    const id = created.id!;
    let shellPid: number | undefined;
    if (mode === "model") await process.wait("model-dispatched");
    else {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try {
          shellPid = Number(
            await readFile(join(root, "work/jobs", id, "shell.pid"), "utf8"),
          );
          break;
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
      }
      assert.ok(shellPid);
    }
    await process.kill();
    // A non-guest test has no service cgroup. Reap only this fixture's known process group.
    if (shellPid) {
      try {
        globalThis.process.kill(-shellPid, "SIGKILL");
      } catch {}
    }
    const { service, faux } = await fixture([], { dataRoot: root });
    try {
      const job = await service.job(id);
      assert.equal(job.status, "waiting");
      assert.equal(job.counters.modelRequests, 1);
      assert.equal(job.limits.modelRequests, 3);
      assert.ok(job.deadlineAt);
      if (mode === "shell") {
        assert.equal(job.waitReason, "reconciliation");
        assert.ok(
          job.operations.some((operation) => operation.status === "unknown"),
        );
        assert.equal(
          (
            await readFile(join(root, "work/jobs", id, "executions"), "utf8")
          ).trim(),
          "once",
        );
      }
      assert.equal(faux.state.callCount, 0);
    } finally {
      await service.close();
    }
  }
});

test("R04 R05 R06 R15: external fixture commits a PR, service is killed before reply; reopen reconciles without resending", async () => {
  const externalRoot = await mkdtemp(join(tmpdir(), "agent-external-store-")),
    statePath = join(externalRoot, "github.json");
  type Remote = {
    writes: number;
    reference: boolean;
    commitMessage: string;
    prs: {
      number: number;
      body: string;
      head: { ref: string; sha: string };
      base: { ref: string };
    }[];
  };
  const remote: Remote = {
    writes: 0,
    reference: false,
    commitMessage: "",
    prs: [],
  };
  await writeFile(statePath, JSON.stringify(remote));
  let committed!: () => void;
  const prCommitted = new Promise<void>((resolveCommit) => {
    committed = resolveCommit;
  });
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<
            string,
            unknown
          >)
        : {};
      const state = JSON.parse(await readFile(statePath, "utf8")) as Remote;
      const reply = (value: unknown, status = 200) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.method === "GET" && request.url!.includes("/git/ref/")) {
        reply(
          state.reference ? { sha: "b".repeat(40) } : {},
          state.reference ? 200 : 404,
        );
        return;
      }
      if (request.method === "GET" && request.url!.includes("/pulls?")) {
        reply(state.prs);
        return;
      }
      if (
        request.method === "GET" &&
        request.url!.endsWith(`/git/commits/${"a".repeat(40)}`)
      ) {
        reply({ sha: "a".repeat(40), tree: { sha: "a".repeat(40) } });
        return;
      }
      if (request.method === "GET" && request.url!.includes("/git/commits/")) {
        reply({ message: state.commitMessage });
        return;
      }
      if (request.url!.endsWith("/git/commits"))
        state.commitMessage = String(payload.message);
      if (request.url!.endsWith("/git/refs")) state.reference = true;
      if (request.url!.endsWith("/pulls") && request.method === "POST") {
        state.writes++;
        state.prs.push({
          number: 1,
          body: String(payload.body),
          head: { ref: String(payload.head), sha: "b".repeat(40) },
          base: { ref: String(payload.base) },
        });
        await writeFile(statePath, JSON.stringify(state));
        committed();
        // Persisted externally, but deliberately lose the response and kill the real service process.
        return;
      }
      await writeFile(statePath, JSON.stringify(state));
      reply({ sha: "b".repeat(40) });
    })().catch(() => {
      response.destroy();
    });
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const root = await mkdtemp(join(tmpdir(), "agent-pr-crash-")),
    process = await crashChild("external", root, String(address.port));
  try {
    const requestId = randomUUID();
    process.child.send({ requestId });
    const created = await process.wait("created");
    await Promise.race([
      prCommitted,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("PR fixture timed out")),
          10000,
        ).unref(),
      ),
    ]);
    await process.kill();
    const transport: GithubTransport = async (path, method, body) => {
      const result = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!result.ok) throw new AppError(result.status, "fixture");
      return result.json() as Promise<unknown>;
    };
    const { service } = await fixture([], {
      noModel: true,
      dataRoot: root,
      github: new GithubConnector(["fixture/repo"], transport),
    });
    try {
      const job = await service.job(created.id!);
      const operation = job.operations.find(
        (operation) => operation.kind === "github",
      )!;
      assert.equal(operation.status, "unknown");
      assert.equal(job.recoveryRequired, true);
      await assert.rejects(
        service.prepare(job.id, "github", "fixture/repo", operation.payload),
        /未知操作/,
      );
      await assert.rejects(
        service.action(job.id, randomUUID(), job.revision, "resume"),
        /未知操作/,
      );
      await service.reconcile(
        job.id,
        randomUUID(),
        job.revision,
        operation.id,
        "check_github",
        "独立した外部 fixture の PR と commit marker を照合しました",
      );
      const reconciled = await service.job(job.id);
      assert.equal(
        reconciled.operations.find((item) => item.id === operation.id)!
          .resultId,
        "1",
      );
      await service.reconcile(
        job.id,
        randomUUID(),
        reconciled.revision,
        "recovery-hold",
        "acknowledge_recovery",
        "クラッシュ前の外部 fixture を確認し、PR 一件だけであることを確認しました",
      );
      assert.equal(
        (JSON.parse(await readFile(statePath, "utf8")) as Remote).writes,
        1,
      );
    } finally {
      await service.close();
    }
  } finally {
    if (process.child.exitCode === null && process.child.signalCode === null)
      await process.kill();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
  }
});

test("R09: a real SQLite backend commit failure seals admission, returns 503 and requires reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-storage-failure-"));
  await mkdir(join(root, "control"), { mode: 0o700 });
  const actual = await openNodeSqliteStorage(
    join(root, "control/state.sqlite"),
  );
  let fail = false;
  const storage = new Proxy(actual, {
    get(target, key) {
      if (key === "commit")
        return (...args: Parameters<Storage["commit"]>) =>
          fail
            ? Promise.reject(new Error("synthetic ENOSPC"))
            : actual.commit(...args);
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { service } = await fixture([], {
    dataRoot: root,
    noModel: true,
    storage,
  });
  const app = await apiServer(
    service,
    "synthetic-private-password-longer-than-32",
    resolve("dist/web"),
  );
  try {
    fail = true;
    await assert.rejects(service.create(jobInput()), /ENOSPC/);
    await service.harness.closed;
    assert.equal(service.healthy(), false);
    assert.equal((await app.inject({ url: "/healthz" })).statusCode, 503);
    await assert.rejects(service.create(jobInput()), /停止/);
  } finally {
    await app.close();
    await service.close().catch(() => undefined);
  }
});
