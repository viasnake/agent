import { lstat, realpath } from "node:fs/promises";
import type { Config } from "../config.js";
import { AgentError } from "../types.js";
import { cleanEnvironment } from "../process.js";
import { within } from "../util.js";
import type { SandboxInvocation } from "./types.js";

export async function bubblewrapInvocation(
  config: Config["execution"],
  root: string,
  command: string[],
  readOnly: boolean,
  extraReadOnly: string[],
): Promise<SandboxInvocation> {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--ro-bind",
    "/usr",
    "/usr",
  ];
  for (const path of ["/bin", "/sbin", "/lib", "/lib64"]) {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink())
        args.push("--symlink", await realpath(path), path);
      else args.push("--ro-bind", path, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  args.push(
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/home",
    "--dir",
    "/etc",
  );
  const runtimePaths = [...config.runtimePaths, ...extraReadOnly];
  for (const path of runtimePaths) {
    const actual = await realpath(path);
    // Runtime mounts are administrator configuration, never model tool arguments.
    if (
      ["/", "/home", "/root", "/etc", "/run", "/var", "/tmp"].includes(
        actual,
      ) ||
      within(root, actual) ||
      within(actual, root)
    )
      throw new AgentError("SANDBOX", `Unsafe runtime mount: ${path}`);
    args.push("--ro-bind", actual, actual);
  }
  const runtimeBin = config.runtimePaths
    .map((p) => (p.endsWith("/bin") ? p : `${p}/bin`))
    .join(":");
  args.push(
    "--setenv",
    "PATH",
    `${runtimeBin ? runtimeBin + ":" : ""}/usr/local/bin:/usr/bin:/bin`,
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "LC_ALL",
    "C.UTF-8",
    readOnly ? "--ro-bind" : "--bind",
    root,
    "/workspace",
    "--chdir",
    "/workspace",
    "--",
    ...command,
  );
  return { command: "/usr/bin/bwrap", args, env: cleanEnvironment };
}
