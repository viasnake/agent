import { lstat, opendir } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { maxSkillBytes, parseDocumentToken } from "./documents.js";
import { AgentError } from "./types.js";
import { readBoundedFile, safePath, sha256 } from "./util.js";
import { secretPath } from "./workspace.js";

export interface SkillFile {
  path: string;
  bytes: number;
}
export interface SkillListing {
  files: SkillFile[];
  limited: boolean;
  skipped: number;
}

function checkPath(path: string): void {
  if (
    !path ||
    path.length > 1500 ||
    /["\\\x00-\x1f\x7f]/.test(path) ||
    path.includes("::") ||
    secretPath(path)
  )
    throw new AgentError(
      "PATH_DENIED",
      "Skill files must use safe workspace-relative paths outside protected directories",
    );
}

export async function readSkill(workspace: string, path: string) {
  checkPath(path);
  parseDocumentToken(`skill:${path}`);
  const file = await safePath(workspace, path);
  const raw = await readBoundedFile(file, maxSkillBytes);
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(raw);
  if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
    throw new AgentError(
      "INPUT",
      "Skill entrypoints must contain nonempty UTF-8 text",
    );
  return { path, bytes: raw.length, sha256: sha256(raw), text };
}

async function listing(
  workspace: string,
  root: string,
  skills: boolean,
): Promise<SkillListing> {
  checkPath(root);
  const result: SkillListing = { files: [], limited: false, skipped: 0 };
  const deadline = Date.now() + 10_000;
  let visited = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    let safe: string;
    try {
      safe = await safePath(workspace, directory);
      if (!(await lstat(safe)).isDirectory())
        throw new AgentError("PATH_DENIED", "Not a skill directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.skipped++;
      return;
    }
    for await (const entry of await opendir(safe)) {
      if (++visited > 200 || Date.now() > deadline) {
        result.limited = true;
        return;
      }
      const path = `${directory}/${entry.name}`;
      try {
        checkPath(path);
        const actual = await safePath(workspace, path);
        const info = await lstat(actual);
        if (info.isDirectory()) {
          if (depth > 0) await walk(path, depth - 1);
          else result.limited = true;
        } else if (
          info.isFile() &&
          info.nlink === 1 &&
          (skills
            ? basename(path) === "SKILL.md"
            : [
                ".md",
                ".txt",
                ".json",
                ".yaml",
                ".yml",
                ".csv",
                ".tsv",
              ].includes(extname(path).toLowerCase()))
        ) {
          if (info.size > maxSkillBytes) result.skipped++;
          else result.files.push({ path, bytes: info.size });
        }
      } catch {
        result.skipped++;
      }
      if (result.limited && visited > 200) return;
    }
  }
  await walk(root, skills ? 1 : 2);
  result.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return result;
}

export function listSkills(workspace: string): Promise<SkillListing> {
  return listing(workspace, "skills", true);
}

export function listSkillReferences(
  workspace: string,
  entrypoint: string,
): Promise<SkillListing> {
  checkPath(entrypoint);
  parseDocumentToken(`skill:${entrypoint}`);
  return listing(workspace, `${dirname(entrypoint)}/references`, false);
}

export function skillAttachments(
  entrypoint: string,
  references: string[],
): string {
  checkPath(entrypoint);
  parseDocumentToken(`skill:${entrypoint}`);
  if (references.length > 7 || new Set(references).size !== references.length)
    throw new AgentError(
      "INPUT_SIZE",
      "Select at most seven distinct skill references",
    );
  for (const path of references) {
    checkPath(path);
    if (
      !path.startsWith(`${dirname(entrypoint)}/references/`) ||
      path.split("/").includes("..")
    )
      throw new AgentError(
        "PATH_DENIED",
        "Skill references must stay in the selected skill's references directory",
      );
  }
  return [`skill:${entrypoint}`, ...references]
    .map((path) => `@"${path}"`)
    .join("\n");
}
