import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  gitReviewPatchBytes,
  gitReviewHistoryLimit,
  type GitReviewRequest,
  type GitReviewResult,
} from "../git-review.js";
import { safeRelative } from "../security.js";

const exec = promisify(execFile);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const fileBytes = 2 * 1024 * 1024;
const listBytes = 512 * 1024;
const metadataBytes = 32 * 1024 * 1024;
const absent = (error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
  throw error;
};
type Reason = Extract<GitReviewResult, { kind: "unavailable" }>["reason"];
class Unavailable extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}
function relative(value: string) {
  try {
    if (value.split("/").some((part) => part.toLowerCase() === ".git"))
      throw new Error();
    return safeRelative(value);
  } catch {
    throw new Unavailable("file");
  }
}
async function plainDirectory(path: string) {
  return (
    (await lstat(path).catch(absent))?.isDirectory() &&
    (await realpath(path)) === path
  );
}
async function readRegular(path: string, maxBytes: number) {
  // O_NONBLOCK keeps a replaced regular file from blocking on open (e.g. a FIFO).
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await fd.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (await realpath(`/proc/self/fd/${fd.fd}`)) !== path
    )
      throw new Unavailable("file");
    if (before.size > maxBytes) throw new Unavailable("limit");
    const data = Buffer.alloc(before.size);
    const { bytesRead } = before.size ? await fd.read(data) : { bytesRead: 0 };
    const after = await fd.stat();
    if (
      bytesRead !== before.size ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size
    )
      throw new Unavailable("changed");
    return { data, mode: before.mode & 0o777 };
  } finally {
    await fd.close();
  }
}
function includeDirectory(name: string) {
  return (
    !name.startsWith(".") &&
    !["node_modules", "attachments", "outputs"].includes(name)
  );
}
async function discover(
  base: string,
  signal: AbortSignal,
): Promise<GitReviewResult> {
  const repositories: string[] = [];
  let seen = 0;
  let limited = false;
  async function walk(path: string, depth: number): Promise<void> {
    signal.throwIfAborted();
    const root = join(base, path);
    if (!(await plainDirectory(root))) return;
    if (await plainDirectory(join(root, ".git"))) {
      if (repositories.length === 30) limited = true;
      else repositories.push(path);
      return;
    }
    for await (const entry of await opendir(root)) {
      signal.throwIfAborted();
      if (++seen > 5000 || repositories.length === 30) {
        limited = true;
        break;
      }
      if (!entry.isDirectory() || !includeDirectory(entry.name)) continue;
      const next = path === "." ? entry.name : `${path}/${entry.name}`;
      if (depth >= 8 || next.length > 240) {
        limited = true;
        continue;
      }
      try {
        relative(next);
      } catch {
        continue;
      }
      await walk(next, depth + 1);
    }
  }
  await walk(".", 0);
  return { kind: "repositories", repositories: repositories.sort(), limited };
}

async function repository(base: string, value: string) {
  const parts = value === "." ? [] : relative(value).split("/");
  if (parts.length > 8 || parts.some((part) => !includeDirectory(part)))
    throw new Unavailable("repository");
  let root = base;
  for (const part of parts) {
    if (await lstat(join(root, ".git")).catch(absent))
      throw new Unavailable("repository");
    root = join(root, part);
    if (!(await plainDirectory(root))) throw new Unavailable("repository");
  }
  const gitDir = join(root, ".git");
  if (!(await plainDirectory(gitDir))) throw new Unavailable("repository");
  return { root, gitDir };
}

async function validateObjects(objects: string, signal: AbortSignal) {
  if (!(await plainDirectory(objects))) throw new Unavailable("repository");
  let entries = 0;
  async function visit(path: string, top: boolean) {
    for await (const entry of await opendir(path)) {
      signal.throwIfAborted();
      if (++entries > 50000) throw new Unavailable("limit");
      const child = join(path, entry.name);
      if (
        top &&
        (entry.name === "pack" ||
          entry.name === "info" ||
          /^[0-9a-f]{2}$/.test(entry.name))
      ) {
        if (!(await plainDirectory(child))) throw new Unavailable("repository");
        await visit(child, false);
      } else if (
        !top &&
        (!entry.isFile() ||
          ["alternates", "http-alternates"].includes(entry.name) ||
          entry.name.endsWith(".promisor"))
      ) {
        throw new Unavailable("repository");
      }
    }
  }
  await visit(objects, true);
}

async function copyMetadata(gitDir: string, shadow: string, working: boolean) {
  // Use an inert Git directory. A checkout's config can define filters,
  // external diff, includes, worktree overrides and credential helpers.
  await mkdir(join(shadow, "refs"), { recursive: true });
  const copy = async (name: string, required = false) => {
    const path = join(gitDir, name);
    const file = await readRegular(path, metadataBytes).catch(absent);
    if (!file) {
      if (required) throw new Unavailable("repository");
      return;
    }
    const target = join(shadow, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.data);
    return file.data;
  };
  const head = (await copy("HEAD", true))!.toString("utf8").trim();
  if (head.startsWith("ref: refs/heads/")) {
    const ref = relative(head.slice(5));
    // Copy only HEAD's loose branch (or let Git resolve it from packed-refs).
    const loose = await copy(ref);
    if (loose && !/^[0-9a-f]{40}\n?$/.test(loose.toString("utf8")))
      throw new Unavailable("repository");
  } else if (!/^[0-9a-f]{40}$/.test(head)) throw new Unavailable("repository");
  await copy("packed-refs");
  await copy("shallow");
  if (working) {
    await copy("index");
    await copy("info/exclude");
  }
}

const diffOptions = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--ignore-submodules=all",
];
const fields = (data: Buffer) => {
  const parts: Buffer[] = [];
  for (
    let start = 0, end;
    (end = data.indexOf(0, start)) !== -1;
    start = end + 1
  )
    parts.push(data.subarray(start, end));
  return parts;
};

type Comparison = Exclude<GitReviewRequest, { kind: "repositories" }>;
async function compare(
  base: string,
  temp: string,
  request: Comparison,
  signal: AbortSignal,
): Promise<GitReviewResult> {
  const { root, gitDir } = await repository(base, request.repo);
  const objects = join(gitDir, "objects");
  await validateObjects(objects, signal);
  const scratch = await mkdtemp(join(temp, "git-review-"));
  try {
    const shadow = join(scratch, "git");
    await copyMetadata(
      gitDir,
      shadow,
      request.kind !== "history" && !request.base,
    );
    const git = async (
      argv: string[],
      working = root,
      maxBuffer = listBytes,
      allowOne = false,
    ) => {
      try {
        const { stdout } = await exec(
          "/usr/bin/git",
          [
            "--no-pager",
            "--no-optional-locks",
            "--literal-pathspecs",
            "--attr-source=HEAD",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "protocol.allow=never",
            "-c",
            "core.commitGraph=false",
            "-c",
            "core.multiPackIndex=false",
            ...argv,
          ],
          {
            cwd: working,
            env: {
              PATH: "/usr/bin:/bin",
              HOME: scratch,
              XDG_CONFIG_HOME: scratch,
              LANG: "C.UTF-8",
              GIT_DIR: shadow,
              GIT_WORK_TREE: working,
              GIT_OBJECT_DIRECTORY: objects,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_ATTR_NOSYSTEM: "1",
              GIT_TERMINAL_PROMPT: "0",
              GIT_NO_LAZY_FETCH: "1",
              GIT_NO_REPLACE_OBJECTS: "1",
            },
            encoding: "buffer",
            maxBuffer,
            signal,
          },
        );
        return stdout;
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { stdout: Buffer };
        if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          throw new Unavailable("limit");
        if (allowOne && Number(failure.code) === 1) return failure.stdout;
        throw error;
      }
    };
    const resolve = async (ref: string) => {
      try {
        return (
          await git([
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${ref}^{commit}`,
          ])
        )
          .toString()
          .trim();
      } catch {
        signal.throwIfAborted();
        throw new Unavailable("commit");
      }
    };
    const head = await resolve("HEAD");
    if (request.kind === "history") {
      const values = fields(
        await git([
          "log",
          "--first-parent",
          "--skip=1",
          `--max-count=${gitReviewHistoryLimit + 1}`,
          "--no-show-signature",
          "-z",
          "--format=%H%x00%as%x00%s",
          head,
          "--",
        ]),
      );
      const commits = [];
      for (
        let i = 0;
        i < values.length && commits.length < gitReviewHistoryLimit;
        i += 3
      ) {
        const [oid, date, subject] = values
          .slice(i, i + 3)
          .map((value) => value.toString("utf8"));
        if (
          !oid ||
          !/^[0-9a-f]{40}$/.test(oid) ||
          !date ||
          subject === undefined
        )
          throw new Unavailable("commit");
        commits.push({
          oid,
          date,
          subject: subject
            .replace(
              /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
              " ",
            )
            .trim()
            .slice(0, 240),
        });
      }
      return {
        kind: "history",
        commits,
        limited: values.length > gitReviewHistoryLimit * 3,
      };
    }

    if (request.kind === "patch" && request.head.toLowerCase() !== head)
      throw new Unavailable("changed");
    const revisions = request.base
      ? [await resolve(request.base), head]
      : [head];
    if (request.kind === "changes") {
      const changed = fields(
        await git([
          "diff",
          ...diffOptions,
          "--name-status",
          "-z",
          ...revisions,
          "--",
        ]),
      );
      const files: Extract<GitReviewResult, { kind: "changes" }>["files"] = [];
      let limited = false;
      function add(raw: Buffer, status: string) {
        if (files.length >= 200) {
          limited = true;
          return;
        }
        if (
          status !== "A" &&
          status !== "D" &&
          status !== "M" &&
          status !== "T" &&
          status !== "U" &&
          status !== "?"
        ) {
          limited = true;
          return;
        }
        try {
          files.push({ path: relative(decoder.decode(raw)), status });
        } catch {
          limited = true;
        }
      }
      for (let index = 0; index + 1 < changed.length; index += 2)
        add(changed[index + 1]!, changed[index]!.toString());
      if (!request.base) {
        const untracked = fields(
          await git(["ls-files", "--others", "--exclude-standard", "-z", "--"]),
        );
        for (const raw of untracked) add(raw, "?");
      }
      return { kind: "changes", head, files, limited };
    }
    const path = relative(request.path);
    if (request.untracked) {
      if (request.base) throw new Unavailable("file");
      const untracked = fields(
        await git([
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
          "--",
          path,
        ]),
      );
      if (!untracked.some((entry) => entry.equals(Buffer.from(path))))
        throw new Unavailable("file");
    }
    let working = scratch;
    if (!request.base) {
      const source = join(root, path);
      const existing = await lstat(source).catch(absent);
      let content: Awaited<ReturnType<typeof readRegular>> | undefined;
      if (existing) {
        if (!(await plainDirectory(dirname(source))) || !existing.isFile())
          throw new Unavailable("file");
        content = await readRegular(source, fileBytes).catch(absent);
      }
      if (request.untracked && !content) throw new Unavailable("changed");
      // Git only reads this verified file for the patch; never a substituted
      // worktree path, symlink target, FIFO or hardlink.
      working = join(scratch, "working");
      const target = join(working, path);
      await mkdir(dirname(target), { recursive: true });
      if (content)
        await writeFile(target, content.data, { mode: content.mode });
    }
    if (!request.untracked) {
      const matches = fields(
        await git(
          [
            "diff",
            ...diffOptions,
            "--name-only",
            "-z",
            ...revisions,
            "--",
            path,
          ],
          working,
        ),
      );
      if (matches.some((match) => !match.equals(Buffer.from(path))))
        throw new Unavailable("file");
    }
    const patch = request.untracked
      ? await git(
          ["diff", ...diffOptions, "--no-index", "--", "/dev/null", path],
          working,
          gitReviewPatchBytes,
          true,
        )
      : await git(
          ["diff", ...diffOptions, "--patch", ...revisions, "--", path],
          working,
          gitReviewPatchBytes,
        );
    let text: string;
    try {
      text = decoder.decode(patch);
    } catch {
      throw new Unavailable("binary");
    }
    if (/^Binary files .* differ$/m.test(text)) throw new Unavailable("binary");
    return { kind: "patch", text };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function gitReview(
  base: string,
  temp: string,
  request: GitReviewRequest,
  signal: AbortSignal,
): Promise<GitReviewResult> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(3500)]);
  try {
    if (!(await plainDirectory(base))) {
      if (request.kind === "repositories")
        return { kind: "repositories", repositories: [], limited: false };
      throw new Unavailable("repository");
    }
    return request.kind === "repositories"
      ? await discover(base, bounded)
      : await compare(base, temp, request, bounded);
  } catch (error) {
    if (error instanceof Unavailable)
      return { kind: "unavailable", reason: error.reason };
    if (bounded.aborted && !signal.aborted)
      return { kind: "unavailable", reason: "limit" };
    if (
      ["ELOOP", "ENOTDIR", "ENOENT"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return { kind: "unavailable", reason: "repository" };
    throw error;
  }
}
