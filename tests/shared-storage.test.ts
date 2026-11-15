import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  access,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ConversationsDoc } from "../src/state.js";
import { createServer } from "../src/server.js";
import { fixture, answer, call, until, TestRunner } from "./support.js";

const exec = promisify(execFile);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function git(cwd: string, ...args: string[]) {
  return (
    await exec("/usr/bin/git", args, {
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
      maxBuffer: 1048576,
    })
  ).stdout.trim();
}
async function sourceRepository(root: string) {
  const path = join(root, "source");
  await mkdir(path);
  await git(path, "init", "--initial-branch=trunk");
  await writeFile(join(path, "code.txt"), "original source\n");
  await git(path, "add", ".");
  await git(path, "commit", "-m", "initial");
  return path;
}
const idle = async (
  service: Awaited<ReturnType<typeof fixture>>["service"],
  id: string,
) => until(async () => (await service.conversation(id)).status === "idle");

test("shared absolute paths work through ordinary Pi tools across sessions, forks and restart without Git preparation or synchronization", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-shared-"));
  const source = await sourceRepository(root);
  const shared = join(root, "work/shared");
  const repo = join(shared, "repos/team/one");
  const note = join(shared, "reference.txt");
  const faux = fauxProvider({
    tokensPerSecond: Infinity,
    models: [{ id: "faux-1" }],
  });
  faux.setResponses([
    call("write", { path: note, content: "shared reference\n" }),
    call("bash", {
      command: `mkdir -p ${quote(join(shared, "repos/team"))} && git clone -- ${quote(source)} ${quote(repo)}`,
    }),
    answer("A done"),
    call("read", { path: note }),
    call("edit", {
      path: note,
      oldText: "shared reference",
      newText: "reused reference",
    }),
    call("read", { path: join(repo, "code.txt") }),
    answer("B done"),
    call("read", { path: note }),
    answer("fork done"),
  ]);
  const requests: string[] = [];
  const provider = {
    ...faux.provider,
    stream: (...args: Parameters<typeof faux.provider.stream>) => {
      requests.push(JSON.stringify(args));
      return faux.provider.stream(...args);
    },
    streamSimple: (...args: Parameters<typeof faux.provider.streamSimple>) => {
      requests.push(JSON.stringify(args));
      return faux.provider.streamSimple(...args);
    },
  };
  const f = await fixture([], { root, provider });
  let service = f.service;
  try {
    const a = await service.create(randomUUID(), "A");
    const b = await service.create(randomUUID(), "B");
    assert.deepEqual((await service.files(a.id)).files, []);
    await assert.rejects(access(shared));
    await service.send(
      a.id,
      randomUUID(),
      "store a reference and clone the repository",
    );
    await idle(service, a.id);
    assert.ok(
      requests.some((request) =>
        request.includes(`Shared persistent directory: ${shared}`),
      ),
    );
    assert.equal(await readFile(note, "utf8"), "shared reference\n");
    const head = await git(repo, "rev-parse", "HEAD");
    await writeFile(join(source, "code.txt"), "new upstream content\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "advance upstream");
    await service.send(
      b.id,
      randomUUID(),
      "read and update the existing shared files",
    );
    await idle(service, b.id);
    assert.equal(await readFile(note, "utf8"), "reused reference\n");
    assert.equal(await git(repo, "rev-parse", "HEAD"), head);
    assert.equal(
      await git(repo, "rev-parse", "refs/remotes/origin/trunk"),
      head,
    );
    assert.equal(
      await readFile(join(repo, "code.txt"), "utf8"),
      "original source\n",
    );
    assert.deepEqual((await service.files(b.id)).files, []);
    await assert.rejects(service.download(b.id, "../shared/reference.txt"));
    const anchor = (await service.view(b.id)).transcript.find((entry) =>
      entry.messages.some((message) => message.content === "B done"),
    )!.id;
    const fork = await service.branch(b.id, randomUUID(), anchor, "fork");
    await service.send(fork.id, randomUUID(), "read the same shared reference");
    await idle(service, fork.id);
    await assert.rejects(
      access(join(root, "work/conversations", fork.id, "repos")),
    );
    const app = await createServer(service);
    try {
      const session = await app.inject({
        url: "/api/session",
        headers: { host: "127.0.0.1:8080" },
      });
      const headers = {
        host: "127.0.0.1:8080",
        cookie: session.headers["set-cookie"]!.toString().split(";")[0]!,
      };
      assert.equal(
        (await app.inject({ url: "/api/repositories", headers })).statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ url: "/api/projects", headers })).statusCode,
        404,
      );
    } finally {
      await app.close();
    }
    await service.deleteConversation(a.id);
    assert.equal(await readFile(note, "utf8"), "reused reference\n");
    assert.equal(await git(repo, "rev-parse", "HEAD"), head);
    await service.close();
    const reopened = await fixture(
      [call("read", { path: note }), answer("reopened")],
      { root },
    );
    service = reopened.service;
    await service.send(b.id, randomUUID(), "reuse after restart");
    await idle(service, b.id);
    assert.equal(await readFile(note, "utf8"), "reused reference\n");
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("existing bare stores, project documents and dirty session worktrees remain untouched by ordinary conversation and reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-existing-git-"));
  const source = await sourceRepository(root);
  const f = await fixture([answer("conversation still works")], { root });
  let service = f.service;
  const LegacyDoc = defineDoc<{ projects: { id: string; name: string }[] }>({
    kind: "agent.projects",
    version: 1,
    scope: "session",
    initial: () => ({ projects: [] }),
    checkpointWhen: () => true,
  });
  try {
    const session = await service.create(randomUUID(), "legacy");
    await f.runner.call(session.id, "init", {});
    const store = join(root, "work/repositories/github.com/example/one.git");
    await mkdir(store, { recursive: true });
    await git(store, "init", "--bare", "--template=");
    await git(store, "fetch", source, "+refs/heads/*:refs/remotes/origin/*");
    const path = join(
      root,
      "work/conversations",
      session.id,
      "repos/example/one",
    );
    await mkdir(join(path, ".."), { recursive: true });
    await git(
      store,
      "worktree",
      "add",
      "-b",
      `agent/${session.id}`,
      path,
      "refs/remotes/origin/trunk",
    );
    await writeFile(join(path, "code.txt"), "uncommitted\n");
    await git(path, "add", "code.txt");
    await writeFile(join(path, "untracked.txt"), "keep\n");
    const status = await git(path, "status", "--porcelain");
    const head = await git(path, "rev-parse", "HEAD");
    await service.harness.commit(async (tx) => {
      const value = {
        id: randomUUID(),
        name: "existing metadata",
        repositories: [
          {
            key: "github.com/example/one",
            remoteUrl: "https://github.com/example/one.git",
            baseCommit: head,
          },
        ],
      };
      (await tx.doc(ConversationsDoc)).conversations.find(
        (record) => record.id === session.id,
      )!.project = value;
      (await tx.doc(LegacyDoc)).projects.push({
        id: value.id,
        name: value.name,
      });
    }, ctx);
    await rm(source, { recursive: true });
    await service.send(
      session.id,
      randomUUID(),
      "normal conversation with an unavailable remote",
    );
    await idle(service, session.id);
    assert.equal(await git(path, "status", "--porcelain"), status);
    assert.equal(await git(path, "rev-parse", "HEAD"), head);
    await service.close();
    service = (await fixture([], { root })).service;
    assert.equal(await git(path, "status", "--porcelain"), status);
    assert.equal(
      (await service.harness.snapshot(LegacyDoc, ctx))!.projects[0]!.name,
      "existing metadata",
    );
    await service.deleteConversation(session.id);
    assert.ok(
      !(await git(store, "worktree", "list", "--porcelain")).includes(path),
    );
    assert.equal(
      await git(store, "rev-parse", `refs/heads/agent/${session.id}`),
      head,
    );
    assert.equal(
      (await service.harness.snapshot(LegacyDoc, ctx))!.projects[0]!.name,
      "existing metadata",
    );
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("optional worktrees are unregistered only for the deleted session and interrupted cleanup resumes from its saved plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-worktrees-"));
  const source = await sourceRepository(root);
  const runner = new TestRunner(join(root, "work"));
  const f = await fixture([], { root, runner });
  let service = f.service;
  try {
    const a = await service.create(randomUUID(), "delete this session");
    const b = await service.create(randomUUID(), "keep this session");
    await runner.call(a.id, "init", {});
    await runner.call(b.id, "init", {});
    const repo = join(root, "work/shared/repo");
    await git(root, "clone", source, repo);
    const aPath = join(root, "work/conversations", a.id, "worktrees/one");
    const secondPath = join(root, "work/conversations", a.id, "worktrees/two");
    const bPath = join(root, "work/conversations", b.id, "worktrees/one");
    for (const [branch, path] of [
      ["a-one", aPath],
      ["a-two", secondPath],
      ["b-one", bPath],
    ]) {
      await mkdir(join(path!, ".."), { recursive: true });
      await git(repo, "worktree", "add", "-b", branch!, path!);
    }
    await writeFile(join(bPath, "code.txt"), "surviving dirty file\n");
    const head = await git(repo, "rev-parse", "HEAD");
    await assert.rejects(
      runner.call(a.id, "worktrees", {
        operation: "remove",
        targets: [{ path: repo, store: join(repo, ".git") }],
      }),
      /outside the deletion scope/,
    );
    await rm(secondPath, { recursive: true });
    const original = runner.call.bind(runner);
    runner.call = async (id, op, args, signal) => {
      if (op === "worktrees" && args.operation === "remove") {
        await original(
          id,
          op,
          { ...args, targets: (args.targets as unknown[]).slice(0, 1) },
          signal,
        );
        throw new Error("injected cleanup interruption");
      }
      return original(id, op, args, signal);
    };
    await assert.rejects(
      service.deleteConversation(a.id),
      /削除が完了していません/,
    );
    assert.equal(service.healthy(), false);
    const marker = JSON.parse(
      await readFile(join(root, "control/session-deletion.json"), "utf8"),
    );
    assert.equal(marker.worktrees.length, 2);
    await service.close();
    runner.call = original;
    service = (await fixture([], { root, runner })).service;
    const registered = await git(repo, "worktree", "list", "--porcelain");
    assert.ok(!registered.includes(aPath) && !registered.includes(secondPath));
    assert.ok(registered.includes(bPath));
    assert.equal(
      await readFile(join(bPath, "code.txt"), "utf8"),
      "surviving dirty file\n",
    );
    for (const branch of ["a-one", "a-two", "b-one"])
      assert.equal(await git(repo, "rev-parse", `refs/heads/${branch}`), head);
    assert.equal(await git(repo, "rev-parse", "HEAD"), head);
    await assert.rejects(access(join(root, "work/conversations", a.id)));
    await assert.rejects(access(join(root, "control/session-deletion.json")));
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a substituted shared directory fails closed and is never repaired", async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep"), "untouched");
    await symlink(outside, join(f.root, "work/shared"));
    await assert.rejects(
      f.runner.call(randomUUID(), "init", {}),
      /Shared directory/,
    );
    assert.equal(await readFile(join(outside, "keep"), "utf8"), "untouched");
  } finally {
    await f.service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
