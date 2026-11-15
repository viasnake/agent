import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repositories } from "../src/execution/repositories.js";
import { TestRunner } from "./support.js";
import type { WorkerRequest, WorkerResult } from "../src/execution/protocol.js";

const exec = promisify(execFile);
export async function git(cwd: string, ...args: string[]) {
  return (
    await exec("/usr/bin/git", args, {
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
}
export async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-projects-"));
  const remotes = new Map<string, string>();
  for (const name of ["one", "two"]) {
    const remote = join(root, name);
    await mkdir(remote);
    await git(remote, "init", "--initial-branch=trunk");
    await writeFile(join(remote, "code.txt"), `shared needle ${name}\n`);
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "initial");
    remotes.set(`https://github.com/example/${name}.git`, remote);
  }
  const work = join(root, "work");
  await mkdir(work);
  const runner = new RepositoryRunner(work, remotes);
  return { root, work, remotes, runner };
}
// Only this test adapter maps validated GitHub identities to local fixture remotes.
// The production API and worker never accept local remotes.
export class RepositoryRunner extends TestRunner {
  network = true;
  calls: string[] = [];
  failCheckoutAfterFirst = false;
  failResolve = false;
  failDelete = false;
  block?: (signal?: AbortSignal) => Promise<void>;
  constructor(
    root: string,
    readonly remotes: Map<string, string>,
  ) {
    super(root);
  }
  override async call(
    id: string,
    op: WorkerRequest["op"],
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    this.calls.push(op === "repositories" ? String(args.operation) : op);
    if (op !== "repositories") return super.call(id, op, args, signal);
    if (this.block) await this.block(signal);
    signal?.throwIfAborted();
    const repositories = new Repositories(this.root, id, async (argv, cwd) => {
      if (argv.includes("fetch") || argv.includes("ls-remote")) {
        this.calls.push("network");
        if (!this.network || this.failResolve)
          throw new Error("fixture offline");
      }
      return git(cwd, ...argv.map((arg) => this.remotes.get(arg) ?? arg));
    });
    if (args.operation === "resolve")
      return {
        data: JSON.stringify({
          repositories: await repositories.resolve(args.repositories),
        }),
      };
    if (args.operation === "fetch")
      return {
        data: JSON.stringify({
          results: await repositories.update(args.repositories),
        }),
      };
    if (args.operation === "remove") {
      if (this.failDelete) {
        await repositories.remove((args.repositories as unknown[]).slice(0, 1));
        throw new Error("injected removal interruption");
      }
      await repositories.remove(args.repositories);
      return {};
    }
    if (this.failCheckoutAfterFirst) {
      await repositories.checkout((args.repositories as unknown[]).slice(0, 1));
      throw new Error("injected checkout interruption");
    }
    await repositories.checkout(args.repositories);
    return {};
  }
}
