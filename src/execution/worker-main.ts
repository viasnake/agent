import { userInfo } from "node:os";
import { serveWorker } from "./worker.js";
if (userInfo().username !== "agent-work" || process.getuid?.() !== 981)
  throw new Error("The fixed work identity is required");
await serveWorker({ root: "/srv/agent-data/work", production: true });
