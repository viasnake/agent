import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { skillsTools } from "../src/skills-tools.js";
import { skillsFixture } from "./skills-fixture.js";

test("public Pi compaction drops history context while the Skills hook restores active instructions and tools remain callable", async () => {
  const s = await skillsFixture();
  await s.add("review");
  const snapshot = await s.loader.discover(),
    registry = createRegistry();
  registry.install(
    skillsTools(
      { toolConversation: async () => "fixture", sanitize: (value) => value },
      snapshot,
    ).extension,
  );
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: Infinity });
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(s.root, "pi.sqlite")),
    {
      models,
      registry,
      settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
    },
    ctx,
  );
  try {
    const pi = await harness.root(ctx, {
      agent: {
        model: { provider: "faux", modelId: "faux-1" },
        instructions: snapshot.catalog(),
      },
    });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("skill_activate", { name: "review" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Finished first step. ".repeat(500)),
      fauxAssistantMessage("Checkpoint: continue review."),
    ]);
    await pi.submit(
      { type: "input", content: "review", requestId: "first" },
      ctx,
    );
    await pi.waitForIdle(ctx);
    const task = await pi.compact(undefined, ctx);
    const result = await harness.waitForTask(task, ctx);
    assert.equal(result.state.status, "terminal");
    await pi.waitForIdle(ctx);
    const history = await pi.context(ctx);
    assert.match(JSON.stringify(history.messages), /compacted into/);
    let checked = false;
    faux.setResponses([
      (context) => {
        assert.match(JSON.stringify(context.messages), /PRIVATE SKILL BODY/);
        checked = true;
        return fauxAssistantMessage(
          fauxToolCall("skill_activate", { name: "review" }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("continued"),
    ]);
    await pi.submit(
      { type: "input", content: "continue review", requestId: "second" },
      ctx,
    );
    await pi.waitForIdle(ctx);
    assert.equal(checked, true);
    assert.match(
      JSON.stringify((await pi.context(ctx)).messages),
      /PRIVATE SKILL BODY/,
    );
  } finally {
    await harness.close(ctx);
    await rm(s.root, { recursive: true });
  }
});

test("active Skill context has a cumulative bound and repeated activation does not consume another slot", async () => {
  const s = await skillsFixture();
  try {
    for (let i = 0; i < 5; i++)
      await s.add(`skill-${i}`, undefined, "x".repeat(60000));
    const runtime = skillsTools(
      { toolConversation: async () => "fixture", sanitize: (value) => value },
      await s.loader.discover(),
    );
    for (let i = 0; i < 4; i++) await runtime.activate(`skill-${i}`);
    await runtime.activate("skill-0");
    await assert.rejects(runtime.activate("skill-4"), /合計サイズ/);
    await runtime.activate("skill-0");
  } finally {
    await rm(s.root, { recursive: true });
  }
});
