import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fixture } from "./support.js";
import { ProjectDoc } from "../src/projects.js";
import { appendPost, type PostContent } from "../src/project-timeline.js";

test("inbox reads and historical deliveries survive new directives, archive and restart", async () => {
  const f = await fixture();
  let service = f.service;
  try {
    const { id } = await service.create(randomUUID(), "月次報告");
    const { piId } = await service.conversation(id);
    const write = (posts: PostContent[]) =>
      service.harness.commit(async (tx) => {
        const p = await tx.doc(ProjectDoc, piId);
        for (const post of posts) {
          if (post.kind === "directive") p.revision++;
          await appendPost(tx, piId, p, post);
        }
      }, ctx);
    // More than one timeline page exists before the workspace is first opened.
    await write([
      { kind: "directive", actor: "user", text: "初版を書いて" },
      {
        kind: "delivery",
        actor: "lead",
        text: "初版",
        deliverable: "本文",
        detail: "初版の検証",
      },
      ...Array.from({ length: 26 }, () => ({
        kind: "progress" as const,
        actor: "member" as const,
        text: "確認中",
      })),
    ]);
    let data = await service.workspaceOverview("1");
    assert.deepEqual(
      data.documents.map((p) => [p.id, p.written]),
      [[2, true]],
    );
    const first = data.threads[0]!.notice!.id;
    await write([
      { kind: "directive", actor: "user", text: "修正を追加" },
      {
        kind: "artifact",
        actor: "lead",
        text: "修正",
        file: "outputs/adopted.patch",
      },
      { kind: "delivery", actor: "lead", text: "修正完了", detail: "確認済み" },
      { kind: "directive", actor: "user", text: "次の依頼" },
    ]);
    await service.readThrough(id, first);
    data = await service.workspaceOverview("1");
    assert.equal(data.threads[0]!.notice!.kind, "delivery");
    assert.ok(data.threads[0]!.notice!.id > data.threads[0]!.readThrough);
    assert.deepEqual(
      data.documents.map((p) => p.text),
      ["修正完了", "修正", "初版"],
    );
    assert.equal(data.documents[1]?.file, "outputs/adopted.patch");
    assert.deepEqual((await service.workspaceOverview()).documents, []);
    await service.readThrough(id, data.threads[0]!.notice!.id);
    assert.equal(
      (await service.readThrough(id, first)).readThrough,
      data.threads[0]!.notice!.id,
    );
    await assert.rejects(service.readThrough(id, 10000), { statusCode: 400 });
    await service.updateConversation(id, { archived: true });
    await service.close();
    service = (await fixture([], { root: f.root })).service;
    const reopened = await service.workspaceOverview("1");
    assert.equal(reopened.documents.length, 3);
    assert.ok(reopened.documents.every((d) => d.archived));
    assert.equal(
      reopened.threads[0]!.readThrough,
      reopened.threads[0]!.notice!.id,
    );
    await service.deleteConversation(id);
    assert.deepEqual(await service.workspaceOverview("1"), {
      documents: [],
      threads: [],
    });
  } finally {
    await service.close();
  }
});
