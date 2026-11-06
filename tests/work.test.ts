import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  fixture,
  jobInput,
  untilJob,
  codeResponses,
  call,
  answer,
} from "./support.js";

test("W01 W07: real Pi tools repair a failing Python fixture, execute tests, deliver an immutable applicable patch", async () => {
  const { service, root, runner } = await fixture(codeResponses(), {
    codeFixture: true,
  });
  try {
    const { id } = await service.create(jobInput());
    const job = await untilJob(
      service,
      id,
      (job) => job.status === "succeeded" || job.status === "failed",
    );
    assert.equal(job.status, "succeeded", job.detail);
    assert.equal(job.validations[0]!.exitCode, 1);
    assert.equal(job.validations[1]!.exitCode, 0);
    assert.ok(job.validations[1]!.command.includes("unittest"));
    const artifact = job.artifacts.find(
      (item) => item.name === "changes.patch",
    )!;
    const patch = await service.artifacts.read(artifact);
    assert.match(patch.toString(), /-    return sum\(values\[1:\]\)/);
    assert.match(patch.toString(), /\+    return sum\(values\)/);
    assert.match(
      await readFile("tests/fixtures/code/calc.py", "utf8"),
      /values\[1:\]/,
    );
    await writeFile(
      join(root, "work/jobs", id, "changes.patch"),
      "changed after delivery",
    );
    assert.deepEqual(await service.artifacts.read(artifact), patch);
    const applied = await runner.call(id, "shell", {
      command: "cd project && git apply --reverse --check ../changes.patch",
      timeout: 10,
      maxBytes: 1048576,
    });
    assert.notEqual(applied.exitCode, 0);
    await writeFile(join(root, "work/jobs", id, "changes.patch"), patch);
    const valid = await runner.call(id, "shell", {
      command: "cd project && git apply --reverse --check ../changes.patch",
      timeout: 10,
      maxBytes: 1048576,
    });
    assert.equal(valid.exitCode, 0, valid.text ?? "");
  } finally {
    await service.close();
  }
});

test("W03 W08: a model success claim without artifacts cannot establish success", async () => {
  const { service } = await fixture([answer("All done, everything passed")]);
  try {
    const { id } = await service.create(jobInput());
    const job = await untilJob(service, id, (job) => job.status === "failed");
    assert.match(job.detail, /patch|実コマンド/);
  } finally {
    await service.close();
  }
});

test("W04: editing after validation invalidates old evidence", async () => {
  const responses = codeResponses();
  responses.splice(
    -1,
    0,
    call("write_file", {
      path: "project/calc.py",
      text: "def total(values):\n    return 0\n",
    }),
  );
  responses.push(answer("I cannot finish"));
  const { service } = await fixture(responses, { codeFixture: true });
  try {
    const { id } = await service.create(jobInput());
    const job = await untilJob(service, id, (job) => job.status === "failed");
    assert.match(job.detail, /現在の版|patch/);
    assert.ok(job.artifacts.length);
  } finally {
    await service.close();
  }
});

test("A01 A02 A03 A08 A09 A10: durable admission, concurrent idempotency, FIFO, missing model, immutable terminal jobs", async () => {
  const instance = await fixture([], { noModel: true });
  let service = instance.service;
  try {
    const input = jobInput();
    const [first, duplicate, second] = await Promise.all([
      service.create(input),
      service.create(input),
      service.create(jobInput()),
    ]);
    assert.equal(first.id, duplicate.id);
    assert.notEqual(first.id, second.id);
    await untilJob(
      service,
      first.id,
      (job) => job.waitReason === "credentials",
    );
    assert.equal((await service.job(second.id)).status, "queued");
    await assert.rejects(
      service.create({ ...input, objective: "different" }),
      /requestId/,
    );
    const job = await service.job(first.id);
    await assert.rejects(
      service.action(first.id, randomUUID(), job.revision - 1, "cancel"),
      /更新/,
    );
    await service.close();
    ({ service } = await fixture([], {
      noModel: true,
      dataRoot: instance.root,
    }));
    assert.equal((await service.create(input)).id, first.id);
    assert.equal((await service.snapshot()).jobs.length, 2);
    const latest = await service.job(first.id);
    await service.action(first.id, randomUUID(), latest.revision, "cancel");
    await untilJob(service, first.id, (job) => job.cleanupConfirmed);
    await assert.rejects(
      service.input(first.id, randomUUID(), "more"),
      /新しい仕事/,
    );
    const continued = await service.create(jobInput({ parentId: first.id }));
    assert.equal((await service.job(continued.id)).parentId, first.id);
    assert.equal((await service.job(first.id)).status, "cancelled");
  } finally {
    await service.close();
  }
});
