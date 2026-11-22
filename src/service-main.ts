import { loadConfig, checkDataRoot } from "./config.js";
import { AgentService } from "./service.js";
import { createServer } from "./server.js";
import { DeploymentGate, listenForDeployment } from "./deploy.js";
process.umask(0o077);
const config = await loadConfig(process.argv[2]!);
await checkDataRoot(config);
const service = await AgentService.open(config);
const gate = new DeploymentGate();
const server = await createServer(service, undefined, gate);
let closeDeployment: (() => void) | undefined;
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  closeDeployment?.();
  const deadline = setTimeout(() => process.exit(1), 25000);
  deadline.unref();
  // Close dispatch first; SSE clients must not keep the listener shutdown alive.
  server.server.closeAllConnections();
  await Promise.all([server.close(), service.close()]);
  clearTimeout(deadline);
}
const requestStop = () => {
  void stop().catch(() => process.exit(1));
};
process.on("SIGTERM", requestStop);
process.on("SIGINT", requestStop);
await server.listen({ host: config.server.host, port: config.server.port });
service.closed
  .then(() => {
    if (!stopping) void stop().finally(() => process.exit(1));
  })
  .catch(() => process.exit(1));
// The installed unit supplies a private runtime directory. Direct development
// starts do not expose the deployment socket.
if (process.env.RUNTIME_DIRECTORY === "/run/agent") {
  closeDeployment = await listenForDeployment(
    "/run/agent/deploy.sock",
    gate,
    service,
    requestStop,
  );
  if (stopping) closeDeployment();
}
console.log(`Agent service listening on port ${config.server.port}`);
