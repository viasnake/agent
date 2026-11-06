import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  symlink,
  link,
  writeFile,
  readFile,
  mkdtemp,
  open,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Worker, assertFileDescriptorPath } from "../src/execution/worker.js";
import { publicUrl, safeRelative, AppError } from "../src/security.js";
import { GithubConnector } from "../src/integrations/github.js";
import { fixture, jobInput, untilJob, call } from "./support.js";
import { checkDataRoot } from "../src/config.js";

const signal = new AbortController().signal;
test("S09: path traversal, symlinks, hardlinks, FIFO and mutated artifact bytes fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-file-boundary-")),
    id = randomUUID();
  const worker = new Worker({ root, production: false });
  const request = (
    op: "init" | "export" | "write",
    args: Record<string, unknown>,
  ) => worker.execute({ id: randomUUID(), jobId: id, op, args }, signal);
  await request("init", {});
  const cwd = join(root, "jobs", id);
  const secret = join(root, "private");
  await writeFile(secret, "synthetic-private-input");
  const openedOutside = await open(secret, "r");
  try {
    await assert.rejects(
      assertFileDescriptorPath(openedOutside.fd, join(cwd, "inside")),
      /changed/,
    );
  } finally {
    await openedOutside.close();
  }
  await symlink(secret, join(cwd, "link"));
  await link(secret, join(cwd, "hard"));
  spawnSync("mkfifo", [join(cwd, "pipe")]);
  await symlink(root, join(cwd, "external-parent"));
  for (const path of [
    "../private",
    "/etc/passwd",
    "link",
    "hard",
    "pipe",
    "external-parent/private",
  ])
    await assert.rejects(request("export", { path }), path);
  await assert.rejects(
    request("write", { path: "external-parent/new", text: "do not write" }),
  );
  const { service } = await fixture([], { noModel: true });
  try {
    const metadata = await service.artifacts.save(
      id,
      "result.txt",
      "text/plain",
      Buffer.from("original"),
      1,
      0,
    );
    await writeFile(join(service.artifacts.root, metadata.id), "tampered");
    await assert.rejects(service.artifacts.read(metadata), /整合性|ハッシュ/);
  } finally {
    await service.close();
  }
});

test("S06 S07 S12: GitHub targets, exact content and protected Git paths cannot be widened by untrusted instructions", async () => {
  let writes = 0;
  const connector = new GithubConnector(["fixture/repo"], async () => {
    writes++;
    throw new AppError(500, "must not dispatch");
  });
  const id = randomUUID(),
    payload = {
      repository: "fixture/repo",
      branch: `codex/job-${id}`,
      base: "master",
      baseSha: "a".repeat(40),
      title: "fixture",
      body: "fixture",
      files: [{ path: "calc.py", content: "fixed" }],
    };
  assert.throws(() =>
    connector.validate({ ...payload, repository: "other/repo" }, id),
  );
  assert.throws(() =>
    connector.validate(
      {
        ...payload,
        files: [
          { path: ".git/config", content: "[credential]\nhelper = malicious" },
        ],
      },
      id,
    ),
  );
  assert.throws(() => connector.validate({ ...payload, branch: "master" }, id));
  assert.equal(writes, 0);
  const { service } = await fixture([
    call("propose_github", { payloadJson: JSON.stringify(payload) }),
  ]);
  try {
    const created = await service.create(jobInput());
    const job = await untilJob(
      service,
      created.id,
      (job) => job.status !== "queued" && job.status !== "running",
    );
    assert.notEqual(job.status, "succeeded");
    assert.equal(job.externalAllowed, false);
    assert.equal(job.approvals.length, 0);
  } finally {
    await service.close();
  }
});

test("S13 V04: unavailable production UID/egress or missing data mount has no insecure fallback", async () => {
  const { service, runner, config } = await fixture([
    call("shell", { command: "printf must-not-run" }),
  ]);
  assert.ok("available" in runner);
  runner.available = false;
  try {
    const { id } = await service.create(jobInput());
    const job = await untilJob(
      service,
      id,
      (job) => job.waitReason === "environment",
    );
    assert.equal(job.counters.modelRequests, 0);
    await assert.rejects(checkDataRoot(config), /mounted/);
  } finally {
    await service.close();
  }
});

test("S14: shell output and command time are bounded; a command log preserves the retained original", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-command-limits-")),
    id = randomUUID();
  const worker = new Worker({ root, production: false });
  await worker.execute(
    { id: randomUUID(), jobId: id, op: "init", args: {} },
    signal,
  );
  const output = await worker.execute(
    {
      id: randomUUID(),
      jobId: id,
      op: "shell",
      args: {
        command: "python3 -c 'print(\"x\"*100000)'",
        timeout: 2,
        maxBytes: 2048,
      },
    },
    signal,
  );
  assert.equal(output.truncated, true);
  assert.equal(output.exitCode, 124);
  assert.ok(output.log);
  assert.equal(
    (await readFile(join(root, "jobs", id, output.log!))).length,
    2048,
  );
  const slow = await worker.execute(
    {
      id: randomUUID(),
      jobId: id,
      op: "shell",
      args: { command: "sleep 10", timeout: 1, maxBytes: 2048 },
    },
    signal,
  );
  assert.equal(slow.exitCode, 124);
});

test("S04: application URL validation rejects encoded private, mapped and credentialed destinations", () => {
  for (const url of [
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://[::ffff:127.0.0.1]/",
    "http://169.254.169.254/",
    "http://10.0.2.2/",
    "https://user:pass@example.com/",
    "file:///etc/passwd",
  ])
    assert.throws(() => publicUrl(url), url);
  assert.equal(publicUrl("http://127.0.0.1:3000/", true).port, "3000");
  assert.throws(() => publicUrl("http://127.0.0.1:8080/", true));
  for (const path of ["../x", "a/../x", "a\\x", "/x", "a//x"])
    assert.throws(() => safeRelative(path));
});

test("S06: expanding configured repositories cannot expand an already admitted job grant", async () => {
  const connector = new GithubConnector(["fixture/repo"], async () => {
    throw new Error("No external dispatch in this test");
  });
  const { service } = await fixture([], { noModel: true, github: connector });
  try {
    const { id } = await service.create(jobInput({ externalAllowed: true }));
    assert.deepEqual((await service.job(id)).allowedRepositories, [
      "fixture/repo",
    ]);
    service.github = new GithubConnector(
      ["fixture/repo", "other/repo"],
      async () => {
        throw new Error("Must not dispatch");
      },
    );
    await assert.rejects(
      service.proposeGithub(await service.job(id), {
        repository: "other/repo",
        branch: `codex/job-${id}`,
        base: "master",
        baseSha: "a".repeat(40),
        title: "must reject",
        body: "untrusted scope expansion",
        files: [{ path: "x.txt", content: "x" }],
      }),
      /許可/,
    );
    assert.equal((await service.job(id)).operations.length, 0);
    const operation = await service.proposeGithub(await service.job(id), {
      repository: "fixture/repo",
      branch: `codex/job-${id}`,
      base: "master",
      baseSha: "a".repeat(40),
      title: "pending approval",
      body: "fixture",
      files: [{ path: "x.txt", content: "x" }],
    });
    const waiting = await service.job(id);
    await assert.rejects(
      service.action(id, randomUUID(), waiting.revision, "resume"),
      /承認または拒否/,
    );
    await service.approve(
      id,
      randomUUID(),
      waiting.revision,
      operation.id,
      false,
    );
    assert.equal((await service.job(id)).operations[0]!.status, "failed");
  } finally {
    await service.close();
  }
});
