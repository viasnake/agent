import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";
import {
  normalizeRepository,
  projectInput,
  branchName,
  projectContext,
} from "../src/projects.js";
import { AgentService } from "../src/service.js";
import { fixture, answer, call, until } from "./support.js";
import { git, repositoryFixture } from "./projects-fixture.js";
import { createServer } from "../src/server.js";

const input = {
  name: "複数 repo",
  repositories: [{ url: "Example/One" }, { url: "example/two" }],
};
const idle = (service: AgentService, id: string) =>
  until(async () => (await service.conversation(id)).status === "idle");

test("GitHub identity, branch and project limits reject unsafe inputs and transport duplicates", () => {
  assert.deepEqual(
    normalizeRepository("Example/One.git"),
    normalizeRepository("https://GITHUB.COM/EXAMPLE/ONE"),
  );
  assert.equal(
    normalizeRepository("git@github.com:Example/One.git").key,
    "github.com/example/one",
  );
  for (const url of [
    "https://token@github.com/a/b",
    "https://github.com/a/b?token=x",
    "https://github.com/a/b#x",
    "https://github.com.evil/a/b",
    "file:///tmp/repo",
    "/tmp/repo",
    "a/..",
    "a/.",
    "a/b\n",
    "a/b/c",
    "ext::command",
    "ssh://git@github.com/a/b",
    "a/%2e%2e",
  ])
    assert.throws(() => normalizeRepository(url), url);
  for (const branch of [
    "-x",
    "a..b",
    "a@{b",
    "a.lock",
    "a/.b",
    "a//b",
    "a/",
    "a\\b",
    "refs/pull/1/head",
    "a:b",
    "a b",
    "a~1",
  ])
    assert.equal(branchName.safeParse(branch).success, false, branch);
  assert.equal(branchName.parse("feature/topic"), "feature/topic");
  assert.equal(
    projectInput.safeParse({
      ...input,
      repositories: [{ url: "a/b" }, { url: "git@github.com:A/B.git" }],
    }).success,
    false,
  );
});

test("real Git workspaces reuse objects offline, isolate files/index/HEAD, fetch refs only and preserve deletion/fork metadata", async () => {
  const r = await repositoryFixture();
  const f = await fixture(
    [
      call("bash", {
        command: "grep -R 'shared needle' repos/ --include=code.txt",
      }),
      call("read", { path: "repos/example/one/code.txt" }),
      call("edit", {
        path: "repos/example/one/code.txt",
        oldText: "shared needle one",
        newText: "edited one",
      }),
      call("write", {
        path: "repos/example/two/new.txt",
        content: "edited two",
      }),
      answer("done"),
      answer("B"),
      answer("C"),
      answer("fork"),
      answer("continued"),
    ],
    { root: r.root, runner: r.runner },
  );
  let service = f.service;
  try {
    const project = await service.saveProject(randomUUID(), input);
    const key = randomUUID();
    const a = await service.create(key, "A", undefined, undefined, project.id);
    assert.deepEqual(
      await service.create(key, "A", undefined, undefined, project.id),
      a,
    );
    const other = await service.saveProject(randomUUID(), {
      ...input,
      name: "同じ repo",
    });
    const b = await service.create(
      randomUUID(),
      "B",
      undefined,
      undefined,
      other.id,
    );
    assert.deepEqual(
      r.runner.calls,
      [],
      "metadata does not execute Git or initialize work",
    );
    await service.send(a.id, randomUUID(), "search, read and edit both repos");
    await idle(service, a.id);
    const one = join(r.work, "repositories/github.com/example/one.git");
    const aPath = join(r.work, "conversations", a.id, "repos/example/one");
    const bPath = join(r.work, "conversations", b.id, "repos/example/one");
    assert.equal(
      await readFile(join(aPath, "code.txt"), "utf8"),
      "edited one\n",
    );
    assert.equal(
      await readFile(
        join(r.work, "conversations", a.id, "repos/example/two/new.txt"),
        "utf8",
      ),
      "edited two",
    );
    r.runner.network = false;
    await service.send(b.id, randomUUID(), "offline B");
    await idle(service, b.id);
    const base = await git(bPath, "rev-parse", "HEAD");
    assert.equal(
      await readFile(join(bPath, "code.txt"), "utf8"),
      "shared needle one\n",
    );
    await git(aPath, "add", "code.txt");
    await git(aPath, "commit", "-m", "session A only");
    const aHead = await git(aPath, "rev-parse", "HEAD");
    await git(aPath, "switch", "-c", "user-topic");
    await writeFile(join(aPath, "code.txt"), "dirty\n");
    await writeFile(join(aPath, "untracked"), "keep");
    await git(aPath, "add", "code.txt");
    const dirty = await git(aPath, "status", "--porcelain");
    assert.equal(await git(bPath, "status", "--porcelain"), "");
    assert.equal(await git(bPath, "rev-parse", "HEAD"), base);
    assert.equal(
      await git(bPath, "rev-parse", `refs/heads/agent/${a.id}`),
      aHead,
      "ordinary refs are shared",
    );
    const remote = r.remotes.get("https://github.com/example/one.git")!;
    await writeFile(join(remote, "code.txt"), "upstream new\n");
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "update");
    r.runner.network = true;
    const fetched = await service.fetchRepositories(a.id);
    assert.ok(fetched.results.every((x) => x.ok));
    assert.equal(
      await git(one, "rev-parse", "refs/remotes/origin/trunk"),
      await git(remote, "rev-parse", "HEAD"),
    );
    assert.equal(await git(aPath, "rev-parse", "HEAD"), aHead);
    assert.equal(await git(aPath, "status", "--porcelain"), dirty);
    assert.equal(await git(bPath, "rev-parse", "HEAD"), base);
    const c = await service.create(
      randomUUID(),
      "C",
      undefined,
      undefined,
      project.id,
    );
    await service.send(c.id, randomUUID(), "updated C");
    await idle(service, c.id);
    assert.equal(
      (await service.conversation(c.id)).project!.repositories[0]!.baseCommit,
      await git(remote, "rev-parse", "HEAD"),
    );
    const view = await service.view(a.id);
    const anchor = view.transcript.find((e) =>
      e.messages.some((m) => m.role === "assistant" && m.content === "done"),
    )!.id;
    const calls = r.runner.calls.length;
    const fork = await service.branch(a.id, randomUUID(), anchor, "fork");
    assert.equal(r.runner.calls.length, calls);
    assert.equal(
      (await service.conversation(fork.id)).project!.repositories[0]!
        .baseCommit,
      base,
    );
    await service.send(fork.id, randomUUID(), "fork");
    await idle(service, fork.id);
    assert.equal(
      await readFile(
        join(r.work, "conversations", fork.id, "repos/example/one/code.txt"),
        "utf8",
      ),
      "shared needle one\n",
    );
    assert.match(
      projectContext((await service.conversation(fork.id)).project),
      /not copied/,
    );
    const edited = await service.saveProject(
      "",
      { name: "changed", repositories: [{ url: "example/two" }] },
      project.id,
      project.revision,
    );
    await assert.rejects(
      service.saveProject("", input, project.id, project.revision),
      /変更されています/,
    );
    await service.deleteProject(project.id, edited.revision);
    assert.equal(
      (await service.conversation(a.id)).project!.repositories.length,
      2,
    );
    r.runner.network = false;
    await service.send(a.id, randomUUID(), "continue after deletion");
    await idle(service, a.id);
    assert.equal(await git(aPath, "status", "--porcelain"), dirty);
    await service.deleteConversation(a.id);
    assert.ok(
      !(await git(one, "worktree", "list", "--porcelain")).includes(aPath),
    );
    assert.equal(
      await git(one, "rev-parse", `refs/heads/agent/${a.id}`),
      aHead,
    );
    assert.equal(await git(one, "rev-parse", "refs/heads/user-topic"), aHead);
    assert.equal(await git(bPath, "rev-parse", "HEAD"), base);
    assert.equal((await service.projects())[0]!.id, other.id);
    assert.equal(
      (await service.conversation(b.id)).project!.repositories[0]!.baseCommit,
      base,
    );
    await service.close();
    const before = r.runner.calls.length;
    service = (await fixture([], { root: r.root, runner: r.runner })).service;
    assert.equal(r.runner.calls.length, before, "reopen is metadata only");
    assert.equal((await service.projects())[0]!.id, other.id);
    assert.equal(
      (await service.conversation(b.id)).project!.repositories[0]!.baseCommit,
      base,
    );
  } finally {
    await service.close();
    await rm(r.root, { recursive: true, force: true });
  }
});

test("failed first fetch and partial checkout retry preserve pinned starts and dirty worktrees; fetch reports each failure", async () => {
  const r = await repositoryFixture();
  const f = await fixture([answer("retried")], {
    root: r.root,
    runner: r.runner,
  });
  try {
    const p = await f.service.saveProject(randomUUID(), input);
    const s = await f.service.create(
      randomUUID(),
      "retry",
      undefined,
      undefined,
      p.id,
    );
    const request = randomUUID();
    r.runner.failResolve = true;
    await assert.rejects(f.service.send(s.id, request, "work"));
    assert.equal(
      (await f.service.conversation(s.id)).project!.repositories[0]!.baseCommit,
      undefined,
    );
    r.runner.failResolve = false;
    r.runner.failCheckoutAfterFirst = true;
    await assert.rejects(
      f.service.send(s.id, request, "work"),
      /checkout interruption/,
    );
    const pinned = (await f.service.conversation(s.id)).project!;
    assert.ok(pinned.repositories.every((r) => r.baseCommit));
    const aPath = join(r.work, "conversations", s.id, "repos/example/one");
    await writeFile(join(aPath, "code.txt"), "preserved dirty");
    r.runner.failCheckoutAfterFirst = false;
    const secondRemote = r.remotes.get("https://github.com/example/two.git")!;
    await writeFile(join(secondRemote, "code.txt"), "new remote version");
    await git(secondRemote, "add", ".");
    await git(
      secondRemote,
      "commit",
      "-m",
      "advance during failed preparation",
    );
    assert.ok(
      (await f.service.fetchRepositories(s.id)).results.every((r) => r.ok),
    );
    r.runner.network = false;
    await f.service.send(s.id, request, "work");
    await idle(f.service, s.id);
    assert.deepEqual((await f.service.conversation(s.id)).project, pinned);
    assert.equal(
      await readFile(join(aPath, "code.txt"), "utf8"),
      "preserved dirty",
    );
    await f.service.send(s.id, request, "work");
    r.runner.network = true;
    const remote = r.remotes.get("https://github.com/example/two.git")!;
    await rm(remote, { recursive: true });
    const results = (await f.service.fetchRepositories(s.id)).results;
    assert.deepEqual(
      results.map((r) => r.ok),
      [true, false],
    );
    assert.equal(results[1]!.key, "github.com/example/two");
  } finally {
    await f.service.close();
    await rm(r.root, { recursive: true, force: true });
  }
});

test("preparation busy rejects competing execution and stop cancels outside admission lock", async () => {
  const r = await repositoryFixture();
  const f = await fixture([], { root: r.root, runner: r.runner });
  try {
    const p = await f.service.saveProject(randomUUID(), input);
    const a = await f.service.create(
      randomUUID(),
      "A",
      undefined,
      undefined,
      p.id,
    );
    const b = await f.service.create(randomUUID(), "B");
    r.runner.block = (signal) =>
      new Promise((_, reject) => {
        if (signal?.aborted) reject(new Error("aborted"));
        signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    const sending = f.service.send(a.id, randomUUID(), "prepare");
    const rejected = assert.rejects(sending, /aborted/);
    await until(
      async () => (await f.service.conversation(a.id)).status === "running",
    );
    await assert.rejects(f.service.send(b.id, randomUUID(), "B"), /busy/);
    await assert.rejects(f.service.fetchRepositories(a.id), /busy/);
    await assert.rejects(f.service.deleteConversation(b.id), /停止/);
    await f.service.stop(b.id);
    assert.equal((await f.service.conversation(a.id)).status, "running");
    await f.service.stop(a.id);
    await rejected;
    assert.equal((await f.service.conversation(a.id)).status, "interrupted");
    assert.equal(
      (await f.service.view(a.id)).transcript.length,
      0,
      "failed unadmitted input is not reported as saved",
    );
  } finally {
    await f.service.close();
    await rm(r.root, { recursive: true, force: true });
  }
});

test("worktree replacement and interrupted deletion fail closed and resume only the target", async () => {
  const r = await repositoryFixture();
  const f = await fixture([answer("A"), answer("B")], {
    root: r.root,
    runner: r.runner,
  });
  let service = f.service;
  try {
    const p = await service.saveProject(randomUUID(), input);
    const a = await service.create(
      randomUUID(),
      "A",
      undefined,
      undefined,
      p.id,
    );
    const b = await service.create(
      randomUUID(),
      "B",
      undefined,
      undefined,
      p.id,
    );
    await service.send(a.id, randomUUID(), "a");
    await idle(service, a.id);
    await service.send(b.id, randomUUID(), "b");
    await idle(service, b.id);
    const aPath = join(r.work, "conversations", a.id, "repos/example/one");
    const bPath = join(r.work, "conversations", b.id, "repos/example/one");
    const pointer = await readFile(join(aPath, ".git"), "utf8");
    await writeFile(
      join(aPath, ".git"),
      await readFile(join(bPath, ".git"), "utf8"),
    );
    await assert.rejects(
      service.send(a.id, randomUUID(), "no overwrite"),
      /作業ツリー/,
    );
    await writeFile(join(aPath, ".git"), pointer);
    r.runner.failDelete = true;
    await assert.rejects(
      service.deleteConversation(a.id),
      /削除が完了していません/,
    );
    assert.equal(service.healthy(), false);
    await service.close();
    r.runner.failDelete = false;
    service = (await fixture([], { root: r.root, runner: r.runner })).service;
    await assert.rejects(service.conversation(a.id), /ありません/);
    assert.equal(
      await readFile(join(bPath, "code.txt"), "utf8"),
      "shared needle one\n",
    );
    assert.equal((await service.projects())[0]!.id, p.id);
  } finally {
    await service.close();
    await rm(r.root, { recursive: true, force: true });
  }
});

test("project API is metadata only, revision checked, normalized and CSRF protected", async () => {
  const r = await repositoryFixture();
  const f = await fixture([], { root: r.root, runner: r.runner });
  const app = await createServer(f.service);
  const headers: Record<string, string> = {
    host: "127.0.0.1:8080",
    origin: "http://127.0.0.1:8080",
  };
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects",
          headers,
          payload: { ...input, requestId: randomUUID() },
        })
      ).statusCode,
      401,
    );
    const session = await app.inject({
      method: "GET",
      url: "/api/session",
      headers,
    });
    headers.cookie = session.headers["set-cookie"]!.toString().split(";")[0]!;
    headers["x-csrf-token"] = session.json().csrf;
    const key = randomUUID();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: { ...input, requestId: key },
    });
    assert.equal(created.statusCode, 201);
    const project = created.json();
    assert.equal(project.repositories[0].key, "github.com/example/one");
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects",
          headers,
          payload: { ...input, requestId: key },
        })
      ).json().id,
      project.id,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: `/api/projects/${project.id}`,
          headers,
          payload: { ...input, revision: 99 },
        })
      ).statusCode,
      409,
    );
    for (const url of [
      "file:///tmp/a",
      "https://token@github.com/a/b",
      "a/../b",
    ])
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/projects",
            headers,
            payload: {
              name: "bad",
              requestId: randomUUID(),
              repositories: [{ url }],
            },
          })
        ).statusCode,
        400,
      );
    const response = await app.inject({
      method: "POST",
      url: "/api/conversations",
      headers,
      payload: {
        requestId: randomUUID(),
        title: "selected",
        projectId: project.id,
      },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/conversations/${response.json().id}`,
          headers,
        })
      ).json().conversation.project.id,
      project.id,
    );
    assert.deepEqual(r.runner.calls, []);
  } finally {
    await app.close();
    await f.service.close();
    await rm(r.root, { recursive: true, force: true });
  }
});

test("Worker Git implementation reuses fixture stores and refuses symlink ancestors, foreign Git metadata and unsafe config", async () => {
  const { symlink, rename } = await import("node:fs/promises");
  const r = await repositoryFixture();
  const f = await fixture([answer("ready")], {
    root: r.root,
    runner: r.runner,
  });
  try {
    const p = await f.service.saveProject(randomUUID(), input);
    const a = await f.service.create(
      randomUUID(),
      "A",
      undefined,
      undefined,
      p.id,
    );
    await f.service.send(a.id, randomUUID(), "prepare");
    await idle(f.service, a.id);
    const project = (await f.service.conversation(a.id)).project!;
    const b = randomUUID();
    const worker = r.runner.worker;
    const run = (operation: string, repositories = project.repositories) =>
      worker.execute(
        {
          id: randomUUID(),
          conversationId: b,
          op: "repositories",
          args: {
            operation,
            repositories,
            commandSeconds: 10,
            commandBytes: 1048576,
          },
        },
        new AbortController().signal,
      );
    await worker.execute(
      { id: randomUUID(), conversationId: b, op: "init", args: {} },
      new AbortController().signal,
    );
    assert.equal(
      JSON.parse((await run("resolve")).data!).repositories[0].baseCommit,
      project.repositories[0]!.baseCommit,
    );
    assert.deepEqual(await run("checkout"), {});
    const bPath = join(r.work, "conversations", b, "repos/example/one");
    assert.equal(
      await readFile(join(bPath, "code.txt"), "utf8"),
      "shared needle one\n",
    );
    const store = join(r.work, "repositories/github.com/example/one.git");
    await git(store, "config", "user.name", "Workspace User");
    await git(store, "config", "user.email", "workspace@example.invalid");
    assert.deepEqual(await run("checkout"), {});
    await git(
      store,
      "symbolic-ref",
      "refs/remotes/origin/trunk",
      `refs/heads/agent/${a.id}`,
    );
    assert.ok(
      JSON.parse(
        (await run("fetch", project.repositories.slice(0, 1))).data!,
      ).results.some((r: { ok: boolean }) => !r.ok),
    );
    await git(store, "symbolic-ref", "--delete", "refs/remotes/origin/trunk");
    await git(
      store,
      "update-ref",
      "refs/remotes/origin/trunk",
      project.repositories[0]!.baseCommit!,
    );
    const config = await readFile(join(store, "config"), "utf8");
    await writeFile(
      join(store, "config"),
      `${config}\n[url "https://evil.invalid/"]\n insteadOf = https://github.com/\n`,
    );
    assert.match(
      JSON.parse((await run("resolve")).data!).error,
      /github.com\/example\/one/,
    );
    await writeFile(join(store, "config"), config);
    await rename(
      join(store, "objects/pack"),
      join(store, "objects/saved-pack"),
    );
    await symlink(
      join(store, "objects/saved-pack"),
      join(store, "objects/pack"),
    );
    assert.ok(JSON.parse((await run("resolve")).data!).error);
    await rm(join(store, "objects/pack"));
    await rename(
      join(store, "objects/saved-pack"),
      join(store, "objects/pack"),
    );
    await rename(
      join(store, "refs/heads/agent"),
      join(store, "refs/heads/saved"),
    );
    await symlink(
      join(store, "refs/heads/saved"),
      join(store, "refs/heads/agent"),
    );
    assert.match(JSON.parse((await run("checkout")).data!).error, /作業ツリー/);
    await rm(join(store, "refs/heads/agent"));
    await rename(
      join(store, "refs/heads/saved"),
      join(store, "refs/heads/agent"),
    );
    const owner = join(r.work, "conversations", b, "repos/example");
    await rename(owner, `${owner}-saved`);
    await symlink(`${owner}-saved`, owner);
    assert.match(JSON.parse((await run("checkout")).data!).error, /作業ツリー/);
    assert.ok(JSON.parse((await run("remove")).data!).error);
    await rm(owner);
    await rename(`${owner}-saved`, owner);
    // An interrupted rm may leave only the target registration. Remove it without pruning others.
    await rm(bPath, { recursive: true });
    assert.deepEqual(await run("remove"), {});
    assert.ok(
      !(await git(store, "worktree", "list", "--porcelain")).includes(bPath),
    );
    assert.ok(
      (await git(store, "worktree", "list", "--porcelain")).includes(a.id),
    );
  } finally {
    await f.service.close();
    await rm(r.root, { recursive: true, force: true });
  }
});

test("repository authentication uses the existing signer and frozen env, cleans up on timeout, and never reaches model context", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { access } = await import("node:fs/promises");
  const r = await repositoryFixture();
  const f = await fixture([], { root: r.root, runner: r.runner });
  const run = promisify(execFile);
  let socket = "",
    sawKeys = false;
  try {
    const settings = f.service.management();
    await f.service.saveSettings({
      revision: settings.revision,
      models: [],
      mcp: [],
      defaultModel: null,
      instructions: "",
      limits: { ...settings.limits, commandSeconds: 1 },
      workCredentials: [
        { id: randomUUID(), name: "ssh", kind: "ssh", generateKey: true },
        {
          id: randomUUID(),
          name: "cli",
          kind: "env",
          env: { GH_TOKEN: "fixture-private-work-token" },
        },
      ],
    });
    const p = await f.service.saveProject(randomUUID(), input);
    const a = await f.service.create(
      randomUUID(),
      "A",
      undefined,
      undefined,
      p.id,
    );
    const original = r.runner.call.bind(r.runner);
    r.runner.call = async (id, op, args, signal) => {
      if (op !== "repositories") return original(id, op, args, signal);
      assert.equal(
        (args.environment as Record<string, string>).GH_TOKEN,
        "fixture-private-work-token",
      );
      assert.ok(!JSON.stringify(args).includes("PRIVATE KEY"));
      socket = String(args.sshSocket);
      const keys = await run("/usr/bin/ssh-add", ["-L"], {
        env: { PATH: "/usr/bin:/bin", SSH_AUTH_SOCK: socket },
      });
      sawKeys = keys.stdout.startsWith("ssh-ed25519 ");
      // The real signer exists for exactly the bounded managed operation.
      await new Promise<void>((_, reject) => {
        if (signal?.aborted) reject(new Error("timeout"));
        signal?.addEventListener("abort", () => reject(new Error("timeout")), {
          once: true,
        });
      });
      return {};
    };
    await assert.rejects(
      f.service.send(a.id, randomUUID(), "prepare"),
      /timeout/,
    );
    assert.ok(sawKeys);
    await assert.rejects(access(socket));
    assert.equal((await f.service.conversation(a.id)).status, "interrupted");
    const view = JSON.stringify(await f.service.view(a.id));
    assert.ok(
      !view.includes("fixture-private-work-token") &&
        !view.includes("PRIVATE KEY"),
    );
  } finally {
    await f.service.close();
    await rm(r.root, { recursive: true, force: true });
  }
});

test("unconfirmed cleanup after Git failure closes the admission gate", async () => {
  const r = await repositoryFixture();
  const f = await fixture([], { root: r.root, runner: r.runner });
  try {
    const p = await f.service.saveProject(randomUUID(), input);
    const a = await f.service.create(
      randomUUID(),
      "A",
      undefined,
      undefined,
      p.id,
    );
    const original = r.runner.call.bind(r.runner);
    let failed = false;
    r.runner.call = async (id, op, args, signal) => {
      if (op === "repositories") {
        failed = true;
        throw new Error("Git failed");
      }
      if (op === "cleanup" && failed) return { cleanup: false };
      return original(id, op, args, signal);
    };
    await assert.rejects(
      f.service.send(a.id, randomUUID(), "prepare"),
      /子プロセスの停止/,
    );
    assert.equal(f.service.healthy(), false);
    await assert.rejects(
      f.service.send(a.id, randomUUID(), "retry"),
      /保存基盤を停止/,
    );
  } finally {
    // Restore the test runner only to close its disposable fixture.
    r.runner.call = Object.getPrototypeOf(r.runner).call.bind(r.runner);
    await f.service.close();
    await rm(r.root, { recursive: true, force: true });
  }
});

test("missing branches and empty remotes identify the repository without admitting input", async () => {
  const { mkdir } = await import("node:fs/promises");
  const r = await repositoryFixture();
  const f = await fixture([], { root: r.root, runner: r.runner });
  try {
    const emptyRemote = join(r.root, "empty");
    await mkdir(emptyRemote);
    await git(emptyRemote, "init", "--bare");
    r.remotes.set("https://github.com/example/empty.git", emptyRemote);
    for (const repository of [
      { url: "example/one", branch: "missing" },
      { url: "example/empty" },
    ]) {
      const p = await f.service.saveProject(randomUUID(), {
        name: "unavailable",
        repositories: [repository],
      });
      const a = await f.service.create(
        randomUUID(),
        "A",
        undefined,
        undefined,
        p.id,
      );
      await assert.rejects(
        f.service.send(a.id, randomUUID(), "prepare"),
        new RegExp(`github.com/${repository.url}:`),
      );
      assert.equal((await f.service.view(a.id)).transcript.length, 0);
      assert.equal(
        (await f.service.conversation(a.id)).project!.repositories[0]!
          .baseCommit,
        undefined,
      );
    }
  } finally {
    await f.service.close();
    await rm(r.root, { recursive: true, force: true });
  }
});
