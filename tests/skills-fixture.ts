import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillsLoader } from "../src/skills.js";
export async function skillsFixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-skills-"));
  await chmod(root, 0o755);
  await mkdir(join(root, "skills"), { mode: 0o755 });
  const loader = new SkillsLoader(root, {
    uid: process.getuid!(),
    boundary: root,
  });
  const add = async (
    name: string,
    frontmatter = `name: ${name}\ndescription: Process documents`,
    body = "PRIVATE SKILL BODY",
  ) => {
    const path = join(root, "skills", name);
    await mkdir(path, { mode: 0o755 });
    await writeFile(
      join(path, "SKILL.md"),
      `---\n${frontmatter}\n---\n${body}`,
      { mode: 0o644 },
    );
    return path;
  };
  return { root, loader, add };
}
