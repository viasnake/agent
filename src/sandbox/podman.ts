import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { AgentError } from "../types.js";
import { podmanEnvironment } from "../platform.js";
import { runProcess } from "../process.js";
import type { SandboxInvocation, SandboxRuntime } from "./types.js";

export async function podmanInvocation(
  config: Config["execution"],
  root: string,
  command: string[],
  readOnly: boolean,
  execute = runProcess,
  runtime?: SandboxRuntime,
): Promise<SandboxInvocation> {
  if (!config.image)
    throw new AgentError(
      "SANDBOX",
      "Configure an image pinned by sha256 before using Podman",
    );
  if (config.runtimePaths.length)
    throw new AgentError(
      "SANDBOX",
      "Podman runtimes must be installed in the pinned Linux image; runtimePaths is only for Bubblewrap",
    );
  if (root.includes(":") || runtime?.path.includes(":"))
    throw new AgentError(
      "SANDBOX",
      "Podman workspace paths must not contain a colon",
    );
  const env = podmanEnvironment();
  const info = await execute(
    "podman",
    ["info", "--format", "{{.Host.Security.Rootless}}"],
    { env, timeoutMs: 10000 },
  );
  if (info.code !== 0 || info.stdout.trim() !== "true")
    throw new AgentError(
      "SANDBOX",
      "Podman must be running in rootless mode; on macOS start a rootless Podman machine",
    );
  const name = `local-agent-${randomUUID()}`;
  return {
    command: "podman",
    env,
    args: [
      "run",
      "--rm",
      "--interactive",
      `--name=${name}`,
      "--pull=never",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=128",
      "--memory=2g",
      "--cpus=2",
      "--userns=keep-id",
      "--tmpfs=/tmp:rw,nosuid,nodev,size=256m",
      `--volume=${root}:/workspace:${readOnly ? "ro" : "rw"}`,
      ...(runtime
        ? [
            `--volume=${runtime.path}:/runtime:${runtime.readOnly ? "ro" : "rw"}`,
          ]
        : []),
      "--workdir=/workspace",
      "--env=HOME=/tmp",
      "--env=TMPDIR=/tmp",
      `--entrypoint=${command[0]}`,
      config.image,
      ...command.slice(1),
    ],
    // Killing the local remote client alone does not stop a VM's container.
    cleanup: async () => {
      const result = await execute(
        "podman",
        ["rm", "--force", "--ignore", name],
        { env, timeoutMs: 10000 },
      );
      if (result.code !== 0)
        throw new AgentError(
          "SANDBOX_CLEANUP",
          `Could not remove sandbox ${name}; check Podman before resuming`,
        );
    },
  };
}
