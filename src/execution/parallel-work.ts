import { execFile } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  fileText,
  gitWorkInput,
  type gitWorkResult,
} from "../parallel-work.js";

export async function gitWork(
  workspace: string,
  environment: Record<string, string>,
  request: z.infer<typeof gitWorkInput>,
  signal: AbortSignal,
): Promise<z.infer<typeof gitWorkResult>> {
  const repo = join(workspace, request.repo);
  const gitDirectory = join(repo, ".git");
  if (
    (await realpath(gitDirectory)) !== gitDirectory ||
    !(await lstat(gitDirectory)).isDirectory()
  )
    throw new Error("Expected a session-local clone");
  const tmp = await mkdtemp(join(workspace, ".parallel-work-"));
  const env = {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ALLOW_PROTOCOL: "file",
  };
  const run = (
    command: string,
    args: string[],
    input = "",
    timeout = 60000,
    maxBuffer = 512000,
  ) =>
    new Promise<Buffer>((resolve, reject) => {
      const child = execFile(
        command,
        args,
        { cwd: tmp, env, encoding: "buffer", signal, timeout, maxBuffer },
        (error, out, err) => {
          if (error)
            reject(
              Object.assign(error, {
                preview: Buffer.concat([out, err])
                  .toString("utf8")
                  .slice(-3900),
              }),
            );
          else
            resolve(command === "/bin/bash" ? Buffer.concat([out, err]) : out);
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  const git = async (args: string[], input = "") =>
    await run(
      "/usr/bin/git",
      ["--literal-pathspecs", "-c", "core.hooksPath=/dev/null", ...args],
      input,
    );
  try {
    await git(["init", "-q", "--template="]);
    await git([
      "fetch",
      "-q",
      "--depth=1",
      "--no-tags",
      "--no-recurse-submodules",
      pathToFileURL(repo).href,
      request.base,
    ]);
    await git(["read-tree", request.base]);
    const entry = async (path: string) => {
      const line = (
        await git(["ls-tree", "-z", request.base, "--", path])
      ).toString("utf8");
      if (!line) return null;
      const m = /^(100644|100755) blob ([0-9a-f]{40})\t/.exec(line);
      if (!m || line.slice(m[0].length) !== path + "\0")
        throw new Error("Assignment requires a regular file");
      return { mode: m[1]!, oid: m[2]! };
    };
    if (request.kind === "sources") {
      const files = [];
      for (const path of request.paths) {
        const item = await entry(path);
        if (!item) {
          files.push(null);
          continue;
        }
        const size = Number(
          (await git(["cat-file", "-s", item.oid])).toString(),
        );
        if (size > 64000)
          throw new Error("Assignment file exceeds the size limit");
        const bytes = await git(["cat-file", "blob", item.oid]);
        files.push(
          fileText.parse(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              bytes,
            ),
          ),
        );
      }
      return { kind: "sources", files };
    }
    if (request.kind === "candidate") {
      for (const { path, content } of request.edits) {
        const item = await entry(path);
        // Git can silently replace an ancestor file or an entire directory on index insertion.
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) {
          const ancestor = (
            await git([
              "ls-tree",
              request.base,
              "--",
              parts.slice(0, i).join("/"),
            ])
          ).toString();
          if (ancestor && !ancestor.startsWith("040000 tree "))
            throw new Error("File parent is not a tree");
        }
        if (content === null)
          await git(["update-index", "--force-remove", "--", path]);
        else {
          const oid = (await git(["hash-object", "-w", "--stdin"], content))
            .toString()
            .trim();
          await git([
            "update-index",
            "--add",
            "--cacheinfo",
            item?.mode ?? "100644",
            oid,
            path,
          ]);
        }
      }
      const tree = (await git(["write-tree"])).toString().trim();
      const patch = (
        await git([
          "diff",
          "--cached",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--full-index",
          "--binary",
          request.base,
          "--",
        ])
      ).toString("utf8");
      if (!patch) throw new Error("The assignments produced no change");
      return { kind: "candidate", tree, patch };
    }
    await git(
      ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"],
      request.patch,
    );
    if ((await git(["write-tree"])).toString().trim() !== request.tree)
      throw new Error("Candidate tree does not match");
    // Give tests a normal detached checkout at the candidate, including a meaningful HEAD.
    const commit = (
      await git([
        "-c",
        "user.name=Agent",
        "-c",
        "user.email=agent@localhost",
        "commit-tree",
        request.tree,
        "-p",
        request.base,
        "-m",
        "Parallel work candidate",
      ])
    )
      .toString()
      .trim();
    await git(["checkout", "-q", "--force", "--detach", commit]);
    try {
      const output = await run(
        "/bin/bash",
        ["--noprofile", "--norc", "-c", request.command],
        "",
        request.seconds * 1000,
        256000,
      );
      signal.throwIfAborted();
      return {
        kind: "check",
        passed: true,
        output: output.toString("utf8").slice(-3900),
      };
    } catch (error) {
      signal.throwIfAborted();
      const e = error as {
        code?: number | string;
        preview?: string;
        killed?: boolean;
      };
      return {
        kind: "check",
        passed: false,
        output: (
          (e.killed
            ? "Check timed out"
            : `Check failed (${e.code ?? "signal"})`) +
          "\n" +
          (e.preview ?? "")
        ).slice(-4000),
      };
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
