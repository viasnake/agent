import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fixture, TestRunner, until } from "./support.js";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";

const root = process.argv[2]!,
  phase = process.argv[3]!;
const runner = new TestRunner(join(root, "work"));
if (phase === "queued") runner.ready = () => new Promise(() => {});
let parentCalls = 0;
const route = (request: { messages: readonly { content: unknown }[] }) => {
  if (
    JSON.stringify(request.messages).includes("single persistent assistant")
  ) {
    if (++parentCalls === 1)
      return fauxAssistantMessage(
        fauxToolCall("session_create", {
          title: "復旧対象",
          text: "一度だけ追記してください",
          criteria: [],
        }),
        { stopReason: "toolUse" },
      );
    if (phase === "reported" && parentCalls === 3)
      void service.exclusive(() => new Promise(() => {}));
    return fauxAssistantMessage("待機します");
  }
  if (phase === "reported") return fauxAssistantMessage("作業の回答");
  return fauxAssistantMessage(
    fauxToolCall("bash", {
      command:
        "echo $$ > shell.pid; printf effect >> outputs/effects.txt; printf ready > started; sleep 30",
    }),
    { stopReason: "toolUse" },
  );
};
const { service } = await fixture(
  Array.from({ length: 8 }, () => route),
  { root, runner },
);
const parent = await service.coordinator.ensure();
await service.send(parent.id, randomUUID(), "作業をお願いします");
await until(async () => (await service.list()).some((c) => c.coordinatorId));
const child = (await service.list()).find((c) => c.coordinatorId)!;
if (phase === "reported")
  await until(async () => {
    const event = (await service.coordinator.state()).activeEvent;
    const session = await service.conversation(parent.id);
    return (
      parentCalls === 3 &&
      !!event &&
      !(await service.harness.snapshot(LiveDoc, session.piId, ctx))?.run
    );
  });
if (phase === "running")
  await until(async () =>
    readFile(join(root, "work/conversations", child.id, "started")).then(
      () => true,
      () => false,
    ),
  );
await writeFile(
  join(root, "ready.json"),
  JSON.stringify({ parentId: parent.id, childId: child.id }),
);
setInterval(() => {}, 1000);
