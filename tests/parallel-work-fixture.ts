import { fixture } from "./support.js";
import { planInput } from "../src/parallel-work.js";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
export async function workFixture(managedProject = false) {
  const f = await fixture();
  const { id } = await f.service.create(
    randomUUID(),
    "parallel",
    undefined,
    undefined,
    managedProject,
  );
  const repo = join(f.root, "work/conversations", id, "repo");
  await mkdir(repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  await writeFile(join(repo, "app.txt"), "old\n");
  await writeFile(join(repo, "README.md"), "old docs\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-qm",
    "base",
  );
  const plan = planInput.parse({
    repo: "repo",
    base: git("rev-parse", "HEAD").trim(),
    goal: "Use the new value and document it",
    assignments: [
      { path: "app.txt", instruction: "Update the value" },
      { path: "README.md", instruction: "Explain the value" },
    ],
    check: 'test "$(cat app.txt)" = new && grep -Fx new README.md',
  });
  const view = async () => (await f.service.view(id)).work.at(-1);
  return { ...f, id, repo, git, plan, view };
}
