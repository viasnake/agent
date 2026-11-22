import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  access,
  link,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "../src/server.js";
import { answer, fixture, until } from "./support.js";
import { git, reviewRepository } from "./git-review-fixture.js";

test("Git review compares actual checkout and commits without changing the index or widening downloads", async (t) => {
  const f = await fixture([answer("done")]);
  const app = await createServer(f.service);
  t.after(async () => {
    await app.close();
    await f.service.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const session = await f.service.create(randomUUID(), "Review");
  const other = await f.service.create(randomUUID(), "Review");
  const work = join(f.root, "work", "conversations", session.id);
  const prefix = `/api/conversations/${session.id}/git`;
  const headers = { host: "127.0.0.1:8080" };
  assert.equal(
    (await app.inject({ url: `${prefix}/repositories`, headers })).statusCode,
    401,
  );
  const cookie = (await app.inject({ url: "/api/session", headers }))
    .cookies[0]!;
  const request = (url: string) =>
    app.inject({ url, headers, cookies: { [cookie.name]: cookie.value } });
  const response = async (op: string, query?: Record<string, string>) => {
    const result = await request(
      `${prefix}/${op}${query ? `?${new URLSearchParams(query)}` : ""}`,
    );
    assert.equal(result.statusCode, 200, result.body);
    return result.json();
  };
  assert.deepEqual(await response("repositories"), {
    kind: "repositories",
    repositories: [],
    limited: false,
  });
  await assert.rejects(access(work));
  await f.service.send(session.id, randomUUID(), "review");
  await until(
    async () => (await f.service.conversation(session.id)).status === "idle",
  );
  const repo = "clones/example";
  const path = join(work, repo);
  const { head, base } = await reviewRepository(path);
  await reviewRepository(join(work, "other"));
  await rm(join(path, "gone.txt"));
  await git(path, "rm", "--", ".gitignore");
  await writeFile(join(path, ".gitignore"), "ignored.txt\n");
  await writeFile(join(path, "staged.txt"), "staged\n");
  await git(path, "add", "--", "staged.txt");
  await writeFile(join(path, "new\nname.txt"), "untracked\n");
  await writeFile(join(path, "ignored.txt"), "ignored\n");
  await writeFile(join(path, "binary.dat"), Buffer.from([0, 1, 255]));
  await writeFile(join(path, "large.txt"), "a\n".repeat(140000));
  await writeFile(join(path, ":(glob)literal"), "literal filename\n");
  await git(path, "pack-refs", "--all");
  const indexBefore = await readFile(join(path, ".git/index"));
  assert.deepEqual(await response("repositories"), {
    kind: "repositories",
    repositories: [repo, "other"],
    limited: false,
  });
  assert.deepEqual(await response("changes", { repo }), {
    kind: "changes",
    files: [
      { path: ".gitignore", status: "D" },
      { path: "app.txt", status: "M" },
      { path: "gone.txt", status: "D" },
      { path: "staged.txt", status: "A" },
      { path: ".gitignore", status: "?" },
      { path: ":(glob)literal", status: "?" },
      { path: "binary.dat", status: "?" },
      { path: "large.txt", status: "?" },
      { path: "new\nname.txt", status: "?" },
    ],
    head,
    limited: false,
  });
  assert.deepEqual(await response("changes", { repo, base }), {
    kind: "changes",
    files: [{ path: "app.txt", status: "M" }],
    head,
    limited: false,
  });
  const patch = (name: string, extra: Record<string, string> = {}) =>
    response("patch", { repo, head, path: name, ...extra });
  assert.match(
    (await patch("app.txt")).text,
    /-committed line\n\+working <script>text<\/script>/,
  );
  assert.match(
    (await patch("app.txt", { base })).text,
    /-original\n\+committed line/,
  );
  assert.match((await patch("gone.txt")).text, /-delete me/);
  assert.match((await patch("staged.txt")).text, /\+staged/);
  assert.match((await patch(".gitignore")).text, /-ignored.txt/);
  assert.match(
    (await patch(".gitignore", { untracked: "1" })).text,
    /\+ignored.txt/,
  );
  assert.match(
    (await patch("new\nname.txt", { untracked: "1" })).text,
    /\+untracked/,
  );
  assert.match(
    (await patch(":(glob)literal", { untracked: "1" })).text,
    /\+literal filename/,
  );
  assert.deepEqual(await patch("ignored.txt", { untracked: "1" }), {
    kind: "unavailable",
    reason: "file",
  });
  assert.deepEqual(await patch("binary.dat", { untracked: "1" }), {
    kind: "unavailable",
    reason: "binary",
  });
  assert.deepEqual(await patch("large.txt", { untracked: "1" }), {
    kind: "unavailable",
    reason: "limit",
  });
  assert.deepEqual(await patch("app.txt", { head: base }), {
    kind: "unavailable",
    reason: "changed",
  });
  assert.deepEqual(await response("changes", { repo, base: "0".repeat(40) }), {
    kind: "unavailable",
    reason: "commit",
  });
  assert.equal(
    (await request(`${prefix}/changes?repo=${repo}&base=--help`)).statusCode,
    400,
  );
  assert.ok(
    (
      await request(
        `/api/conversations/${session.id}/download?path=${repo}/app.txt`,
      )
    ).statusCode >= 400,
  );
  assert.deepEqual(
    (await request(`/api/conversations/${other.id}/git/repositories`)).json()
      .repositories,
    [],
  );
  assert.deepEqual(await readFile(join(path, ".git/index")), indexBefore);
});

test("Git review rejects paths and metadata outside the session and ignores repository-defined executables", async (t) => {
  const f = await fixture([answer("done")]);
  t.after(async () => {
    await f.service.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const { id } = await f.service.create(randomUUID(), "Review");
  await f.service.send(id, randomUUID(), "review");
  await until(async () => (await f.service.conversation(id)).status === "idle");
  const work = join(f.root, "work", "conversations", id);
  const outside = join(f.root, "outside");
  await reviewRepository(outside);
  await symlink(outside, join(work, "outside"));
  await mkdir(join(work, "fake"));
  await symlink(join(outside, ".git"), join(work, "fake", ".git"));
  await mkdir(join(work, "pointer"));
  await writeFile(
    join(work, "pointer", ".git"),
    `gitdir: ${join(outside, ".git")}\n`,
  );
  const path = join(work, "repo");
  const { head } = await reviewRepository(path);
  const marker = join(work, "should-not-run");
  await git(path, "config", "filter.marker.clean", `touch ${marker}; cat`);
  await git(path, "config", "diff.marker.command", `touch ${marker}`);
  await git(path, "config", "core.worktree", outside);
  await writeFile(
    join(path, ".gitattributes"),
    "app.txt filter=marker diff=marker\n",
  );
  await symlink(join(outside, "app.txt"), join(path, "symlink.txt"));
  await link(join(outside, "gone.txt"), join(path, "hardlink.txt"));
  assert.deepEqual(await f.service.gitReview(id, { kind: "repositories" }), {
    kind: "repositories",
    repositories: ["repo"],
    limited: false,
  });
  for (const repo of ["outside", "fake", "pointer", "../..", outside]) {
    const result = await f.service.gitReview(id, { kind: "changes", repo });
    assert.equal(result.kind, "unavailable", repo);
  }
  assert.equal(
    (await f.service.gitReview(id, { kind: "changes", repo: "repo" })).kind,
    "changes",
  );
  const patch = (name: string) =>
    f.service.gitReview(id, { kind: "patch", repo: "repo", head, path: name });
  assert.equal((await patch("app.txt")).kind, "patch");
  for (const name of [
    "symlink.txt",
    "hardlink.txt",
    ".git/config",
    "../other.txt",
  ]) {
    assert.deepEqual(await patch(name), {
      kind: "unavailable",
      reason: "file",
    });
  }
  await assert.rejects(access(marker));
  await writeFile(
    join(path, ".git/objects/info/alternates"),
    join(outside, ".git/objects") + "\n",
  );
  assert.deepEqual(
    await f.service.gitReview(id, { kind: "changes", repo: "repo" }),
    { kind: "unavailable", reason: "repository" },
  );
});
