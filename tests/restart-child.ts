import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, call, until } from "./support.js";
const f = await fixture(
  [
    call("bash", {
      command:
        "echo $$ > shell.pid; printf effect >> outputs/effects.txt; printf ready > started; sleep 30",
    }),
  ],
  { root: process.argv[2]! },
);
const { id } = await f.service.create(randomUUID(), "中断の復旧");
await writeFile(join(f.root, "conversation-id"), id);
await f.service.send(id, randomUUID(), "実行してください");
setInterval(() => {}, 1000);

await until(async () =>
  readFile(join(f.root, "work/conversations", id, "started")).then(
    () => true,
    () => false,
  ),
);
await f.service.send(id, randomUUID(), "追加した指示も保持してください");
await writeFile(join(f.root, "queued"), "ready");
