import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { Config } from "./config.js";
import { AgentError } from "./types.js";
import { runProcess, type ProcessResult } from "./process.js";
import { privateDirectory, sha256, within } from "./util.js";
import { bubblewrapInvocation } from "./sandbox/bubblewrap.js";
import { podmanInvocation } from "./sandbox/podman.js";
import type { SandboxInvocation, SandboxRuntime } from "./sandbox/types.js";

export class Sandbox {
  constructor(
    readonly config: Config["execution"],
    private readonly platform = process.platform,
    private readonly processRunner = runProcess,
  ) {}

  async invocation(
    workspace: string,
    command: string[],
    readOnly = false,
    extraReadOnly: string[] = [],
    runtime?: SandboxRuntime,
  ): Promise<SandboxInvocation> {
    if (!command.length || !command[0])
      throw new AgentError("SANDBOX", "A sandbox command is required");
    if (!["linux", "darwin"].includes(this.platform))
      throw new AgentError(
        "SANDBOX",
        "Command isolation supports Linux and macOS",
      );
    if (this.config.backend === "disabled")
      throw new AgentError("SANDBOX", "Command execution is disabled");
    const root = await realpath(workspace);
    if (runtime) {
      await privateDirectory(runtime.path);
      const path = await realpath(runtime.path);
      if (within(root, path) || within(path, root))
        throw new AgentError(
          "SANDBOX",
          "Runtime storage must be separate from the workspace",
        );
      runtime = { ...runtime, path };
    }
    if (this.config.backend === "podman")
      return podmanInvocation(
        this.config,
        root,
        command,
        readOnly,
        this.processRunner,
        runtime,
      );
    if (this.platform !== "linux")
      throw new AgentError(
        "SANDBOX",
        "Bubblewrap requires Linux; configure Podman on macOS",
      );
    return bubblewrapInvocation(
      this.config,
      root,
      command,
      readOnly,
      extraReadOnly,
      runtime,
    );
  }

  private async run(
    workspace: string,
    command: string[],
    signal: AbortSignal,
    readOnly: boolean,
    limits?: { timeoutMs: number; maxBytes: number },
    runtime?: SandboxRuntime,
  ): Promise<ProcessResult> {
    signal.throwIfAborted();
    const invocation = await this.invocation(
      workspace,
      command,
      readOnly,
      [],
      runtime,
    );
    try {
      return await this.processRunner(invocation.command, invocation.args, {
        signal,
        env: invocation.env,
        timeoutMs:
          limits?.timeoutMs ?? this.config.commandTimeoutSeconds * 1000,
        maxBytes: limits?.maxBytes ?? this.config.maxOutputBytes,
      });
    } finally {
      await invocation.cleanup?.();
    }
  }

  async execute(
    workspace: string,
    command: string,
    signal: AbortSignal,
    readOnly = false,
    runtime?: SandboxRuntime,
  ): Promise<ProcessResult> {
    return this.run(
      workspace,
      ["/bin/sh", "-c", command],
      signal,
      readOnly,
      undefined,
      runtime,
    );
  }

  async executeArgs(
    workspace: string,
    command: string[],
    signal: AbortSignal,
    readOnly = true,
    maxBytes = this.config.maxOutputBytes,
    timeoutMs = 30000,
  ): Promise<ProcessResult> {
    maxBytes = Math.min(maxBytes, this.config.maxOutputBytes);
    timeoutMs = Math.min(timeoutMs, this.config.commandTimeoutSeconds * 1000);
    return this.run(workspace, command, signal, readOnly, {
      timeoutMs,
      maxBytes,
    });
  }

  async verifyExecutable(
    workspace: string,
    command: string,
    digest: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (posix.normalize(command) !== command || !command.startsWith("/"))
      throw new AgentError(
        "MCP_CHANGED",
        "MCP command must be a normalized absolute path",
      );
    let actual: string;
    if (this.config.backend === "podman") {
      // macOS executables cannot run in a Linux VM. Verify the image's program.
      if (
        ["/workspace", "/tmp", "/proc", "/dev"].some(
          (p) => command === p || command.startsWith(`${p}/`),
        )
      )
        throw new AgentError(
          "MCP_CHANGED",
          "MCP executable must belong to the immutable image",
        );
      const result = await this.run(
        workspace,
        ["/usr/bin/sha256sum", "--", command],
        signal,
        true,
      );
      if (result.code !== 0)
        throw new AgentError(
          "MCP_CHANGED",
          "Cannot hash the MCP executable in the pinned image",
        );
      actual = result.stdout.split(/\s/)[0]!;
    } else {
      actual = sha256(await readFile(command));
    }
    if (actual !== digest)
      throw new AgentError(
        "MCP_CHANGED",
        "MCP executable no longer matches its pinned hash",
      );
  }

  async probe(workspace: string): Promise<{ ok: boolean; detail: string }> {
    let markerDirectory: string | undefined;
    let visibleDirectory: string | undefined;
    try {
      const root = await realpath(workspace);
      markerDirectory = await mkdtemp(join(dirname(root), ".sandbox-probe-"));
      visibleDirectory = await mkdtemp(join(root, ".sandbox-visible-"));
      const visibleName = visibleDirectory.slice(root.length + 1);
      await writeFile(join(visibleDirectory, "visible"), "mounted", {
        mode: 0o600,
      });
      const marker = join(markerDirectory, "host-only");
      await writeFile(marker, "host-only", { mode: 0o600 });
      const hidden = [marker, "/var/run/docker.sock"];
      if (this.config.backend === "bubblewrap") hidden.push("/etc/shadow");
      const quote = (path: string) => "'" + path.replace(/'/g, "'\\''") + "'";
      const result = await this.execute(
        workspace,
        'test "$HOME" = /tmp && test "$PWD" = /workspace && ' +
          `test "$(cat /workspace/${visibleName}/visible)" = mounted && ` +
          hidden.map((path) => `test ! -e ${quote(path)}`).join(" && "),
        AbortSignal.timeout(15000),
        true,
      );
      return {
        ok: result.code === 0,
        detail:
          result.code === 0
            ? `${this.config.backend}: isolated command succeeded`
            : result.stderr || "Isolation probe failed",
      };
    } catch (error) {
      return {
        ok: false,
        detail:
          error instanceof Error ? error.message : "Isolation unavailable",
      };
    } finally {
      if (visibleDirectory)
        await rm(visibleDirectory, { recursive: true, force: true });
      if (markerDirectory)
        await rm(markerDirectory, { recursive: true, force: true });
    }
  }

  static nodeRuntimeDirectory(): string {
    return dirname(dirname(process.execPath));
  }
}
