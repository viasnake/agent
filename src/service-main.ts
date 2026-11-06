import { loadConfig, checkDataRoot, privateFile } from "./config.js";
import { AgentService } from "./service.js";
import { createServer } from "./server.js";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
process.umask(0o077);
const config = await loadConfig(process.argv[2]!);
await checkDataRoot(config);
const recovery = await lstat("/run/agent-recovery-hold").catch(() => null);
if (
  recovery &&
  (!recovery.isFile() || recovery.uid !== 0 || recovery.mode & 0o022)
)
  throw new Error("Invalid recovery marker");
config.recoveryHold ||= !!recovery;
const service = await AgentService.open(config);
const server = await createServer(
  service,
  await privateFile(join(config.dataRoot, "control/secrets/ui-password")),
);
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 25000);
  deadline.unref();
  // Close dispatch first; SSE clients must not keep the listener shutdown alive.
  server.server.closeAllConnections();
  await Promise.all([server.close(), service.close()]);
  clearTimeout(deadline);
}
process.on("SIGTERM", () => {
  void stop().catch(() => process.exit(1));
});
process.on("SIGINT", () => {
  void stop().catch(() => process.exit(1));
});
await server.listen({ host: config.server.host, port: config.server.port });
service.harness.closed
  .then(() => {
    if (!stopping) void stop().finally(() => process.exit(1));
  })
  .catch(() => process.exit(1));
console.log(`Agent service listening on port ${config.server.port}`);
