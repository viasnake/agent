import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

// Commands may detach from their shell. The kernel keeps all descendants in
// this operation's cgroup across fork, exec and setsid.
export async function operationGroup() {
  const entry = (await readFile("/proc/self/cgroup", "utf8"))
    .trim()
    .split("\n")
    .find((line) => line.startsWith("0::/"));
  if (!entry) throw new Error("A delegated cgroup v2 service is required");
  const current = join("/sys/fs/cgroup", entry.slice(3));
  if (process.getuid?.() !== 0 && basename(current) !== "control")
    throw new Error("The control service requires DelegateSubgroup=control");
  const parent = basename(current) === "control" ? dirname(current) : current;
  const group = join(parent, "work-" + randomUUID());
  await mkdir(group);
  try {
    // Verify cleanup before allowing arbitrary work to start.
    await writeFile(join(group, "cgroup.kill"), "1");
    return group;
  } catch (error) {
    await rmdir(group);
    throw error;
  }
}

export async function removeGroup(group: string) {
  await writeFile(join(group, "cgroup.kill"), "1");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      /^populated 0$/m.test(
        await readFile(join(group, "cgroup.events"), "utf8"),
      )
    ) {
      await rmdir(group);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Worker cgroup cleanup was not confirmed");
}
