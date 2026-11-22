import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export async function git(cwd: string, ...args: string[]) {
  return (
    await exec("/usr/bin/git", args, {
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    })
  ).stdout.trim();
}

export async function reviewRepository(path: string) {
  await mkdir(path, { recursive: true });
  await git(path, "init", "--initial-branch=main", "--object-format=sha1");
  await writeFile(join(path, "app.txt"), "original\n");
  await writeFile(join(path, "gone.txt"), "delete me\n");
  await writeFile(join(path, ".gitignore"), "ignored.txt\n");
  await git(path, "add", ".");
  await git(path, "commit", "-m", "original");
  const base = await git(path, "rev-parse", "HEAD");
  await writeFile(join(path, "app.txt"), "committed line\n");
  await git(path, "commit", "-am", "committed change");
  const head = await git(path, "rev-parse", "HEAD");
  await writeFile(join(path, "app.txt"), "working <script>text</script>\n");
  return { base, head };
}
