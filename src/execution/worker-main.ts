import { userInfo } from "node:os";
import { join } from "node:path";
import { readInstallation } from "../installation.js";
import { serveWorker } from "./worker.js";
const installation = await readInstallation();
if (
  userInfo().username !== "agent-work" ||
  process.getuid?.() !== installation.workUid
)
  throw new Error("The installed work identity is required");
await serveWorker({
  root: join(installation.dataRoot, "work"),
  production: true,
});
