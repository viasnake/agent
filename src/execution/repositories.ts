import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  branchName,
  repositoryBindings,
  type RepositoryBinding,
} from "../projects.js";

export type GitExec = (args: string[], cwd: string) => Promise<string>;
const absent = (error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
};

// Work owns these paths. Refuse substituted ancestors before every managed mutation.
async function directory(path: string, create = false): Promise<boolean> {
  if (path === "/") return true;
  if (!(await directory(dirname(path), create))) return false;
  if (create)
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  const info = await lstat(path).catch(absent);
  if (!info) return false;
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path
  )
    throw new Error("Repository directory was replaced");
  return true;
}
async function regular(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 65536)
    throw new Error("Unsafe Git metadata");
  return readFile(path, "utf8");
}
export class Repositories {
  constructor(
    private root: string,
    private sessionId: string,
    private exec: GitExec,
  ) {}
  private paths(repo: RepositoryBinding) {
    return {
      store: join(this.root, "repositories", `${repo.key}.git`),
      path: join(
        this.root,
        "conversations",
        this.sessionId,
        "repos",
        repo.key.slice(11),
      ),
    };
  }
  private async git(store: string, args: string[]) {
    await directory(store);
    return this.exec(["--git-dir", store, ...args], this.root);
  }
  private async validateStore(store: string) {
    if (!(await directory(store)))
      throw new Error("Shared repository is missing");
    await regular(join(store, "HEAD"));
    await regular(join(store, "config"));
    for (const part of ["objects", "refs", "refs/heads"])
      if (!(await directory(join(store, part))))
        throw new Error("Invalid shared repository");
    // Local configuration is shared with ordinary Git. Refuse includes, URL rewriting,
    // executable filters and transport overrides in managed operations.
    const config = await this.exec(
      [
        "config",
        "--file",
        join(store, "config"),
        "--no-includes",
        "--null",
        "--list",
      ],
      this.root,
    );
    for (const entry of config.split("\0").filter(Boolean)) {
      const key = entry.split("\n", 1)[0]!;
      if (
        !/^(user\.(name|email)|credential\.(helper|https:\/\/github\.com\.helper|usehttppath)|core\.(repositoryformatversion|filemode|bare|logallrefupdates)|remote\.[^.]+\.(url|fetch)|branch\..+\.(remote|merge)|extensions\.objectformat)$/.test(
          key,
        )
      )
        throw new Error(
          "Shared repository configuration is not supported for managed operations",
        );
    }
    if (
      (await this.git(store, ["rev-parse", "--is-bare-repository"])).trim() !==
      "true"
    )
      throw new Error("Expected a bare repository");
    for (const part of [
      "refs/remotes",
      "refs/remotes/origin",
      "worktrees",
      "objects/info",
      "objects/pack",
      "logs",
    ])
      await directory(join(store, part));
    for (const entry of await readdir(join(store, "objects"), {
      withFileTypes: true,
    })) {
      if (entry.isSymbolicLink()) throw new Error("Unsafe object directory");
      if (entry.isDirectory())
        await directory(join(store, "objects", entry.name));
    }
    const packed = await lstat(join(store, "packed-refs")).catch(absent);
    if (packed && (!packed.isFile() || packed.nlink !== 1))
      throw new Error("Unsafe packed references");
    let scanned = 0;
    const checkRefs = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (++scanned > 20000) throw new Error("Reference limit exceeded");
        const child = join(path, entry.name),
          info = await lstat(child);
        if (
          info.isSymbolicLink() ||
          (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
        )
          throw new Error("Unsafe Git reference path");
        if (info.isDirectory()) await checkRefs(child);
        else if (
          child.startsWith(join(store, "refs/remotes") + "/") &&
          (await regular(child)).startsWith("ref:")
        )
          throw new Error(
            "Remote-tracking references must not redirect writes to local branches",
          );
      }
    };
    await checkRefs(join(store, "refs"));
    if (await directory(join(store, "logs")))
      await checkRefs(join(store, "logs"));
    // Git reads alternate object paths implicitly; managed stores never create these.
    if (await lstat(join(store, "objects/info/alternates")).catch(absent))
      throw new Error("Alternate object stores are unsupported");
  }
  private async fetch(store: string, repo: RepositoryBinding) {
    await this.git(store, [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-auto-maintenance",
      "--",
      repo.remoteUrl,
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
  }
  private async ensureStore(repo: RepositoryBinding): Promise<string> {
    const { store } = this.paths(repo);
    if (await lstat(store).catch(absent)) {
      await this.validateStore(store);
      return store;
    }
    await directory(dirname(store), true);
    const staging = await mkdtemp(`${store}.preparing-`);
    try {
      await this.exec(["init", "--bare", "--template=", staging], this.root);
      await this.fetch(staging, repo);
      const head = await this.git(staging, [
        "ls-remote",
        "--symref",
        "--",
        repo.remoteUrl,
        "HEAD",
      ]);
      const match = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(head);
      if (!match) throw new Error("Remote HEAD could not be resolved");
      const branch = branchName.parse(match[1]);
      await this.git(staging, [
        "rev-parse",
        "--verify",
        `refs/remotes/origin/${branch}^{commit}`,
      ]);
      await writeFile(join(staging, "agent-default-branch"), branch, {
        flag: "wx",
        mode: 0o600,
      });
      await this.validateStore(staging);
      await directory(dirname(store));
      if (await lstat(store).catch(absent))
        throw new Error("Repository appeared during preparation");
      await rename(staging, store);
      return store;
    } finally {
      if (await directory(staging)) await rm(staging, { recursive: true });
    }
  }
  async resolve(repositories: unknown): Promise<RepositoryBinding[]> {
    const results: RepositoryBinding[] = [];
    for (const repo of repositoryBindings.parse(repositories)) {
      try {
        const store = await this.ensureStore(repo);
        if (repo.baseCommit) {
          await this.git(store, [
            "cat-file",
            "-e",
            `${repo.baseCommit}^{commit}`,
          ]);
          results.push(repo);
          continue;
        }
        const resolvedBranch =
          repo.branch ??
          branchName.parse(await regular(join(store, "agent-default-branch")));
        const baseCommit = (
          await this.git(store, [
            "rev-parse",
            "--verify",
            `refs/remotes/origin/${resolvedBranch}^{commit}`,
          ])
        ).trim();
        results.push({ ...repo, resolvedBranch, baseCommit });
      } catch {
        throw new Error(
          `${repo.key}: 取得または開始ブランチの解決に失敗しました`,
        );
      }
    }
    return repositoryBindings.parse(results);
  }
  private async registered(store: string, path: string): Promise<boolean> {
    const output = await this.git(store, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    return output.split("\0").includes(`worktree ${path}`);
  }
  private async validateMissingRegistration(store: string, path: string) {
    const registrations = join(store, "worktrees");
    if (!(await directory(registrations)))
      throw new Error("Missing registration directory");
    const names = await readdir(registrations);
    if (names.length > 1000) throw new Error("Too many worktree registrations");
    let found = false;
    for (const name of names) {
      const admin = join(registrations, name);
      await directory(admin);
      if ((await regular(join(admin, "gitdir"))).trim() !== join(path, ".git"))
        continue;
      if (
        found ||
        resolve(admin, (await regular(join(admin, "commondir"))).trim()) !==
          store
      )
        throw new Error("Ambiguous worktree registration");
      await regular(join(admin, "HEAD"));
      found = true;
    }
    if (!found) throw new Error("Missing worktree registration");
  }
  private async validateWorktree(store: string, path: string) {
    if (!(await directory(path))) throw new Error("Worktree is missing");
    const pointer = await regular(join(path, ".git"));
    const admin = pointer.trim().replace(/^gitdir: /, "");
    if (
      dirname(admin) !== join(store, "worktrees") ||
      !/^[-\w.]+$/.test(admin.slice(dirname(admin).length + 1))
    )
      throw new Error("Worktree points to another store");
    if (!(await directory(admin)))
      throw new Error("Missing worktree registration");
    if (
      resolve(admin, (await regular(join(admin, "commondir"))).trim()) !==
        store ||
      (await regular(join(admin, "gitdir"))).trim() !== join(path, ".git")
    )
      throw new Error("Worktree registration mismatch");
    if (!(await this.registered(store, path)))
      throw new Error("Worktree path is not registered");
    const common = (
      await this.exec(
        ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        this.root,
      )
    ).trim();
    if (common !== store) throw new Error("Worktree common directory mismatch");
  }
  async checkout(repositories: unknown): Promise<void> {
    for (const repo of repositoryBindings.parse(repositories)) {
      try {
        if (!repo.baseCommit)
          throw new Error("Starting commits must be persisted first");
        const { store, path } = this.paths(repo);
        await this.validateStore(store);
        if (await lstat(path).catch(absent)) {
          await this.validateWorktree(store, path);
          continue;
        }
        await directory(dirname(path), true);
        if (await this.registered(store, path))
          throw new Error(
            "Missing registered worktree; inspect before retrying",
          );
        const branch = `agent/${this.sessionId}`;
        const refs = await this.git(store, [
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          `refs/heads/${branch}`,
        ]);
        if (
          refs.trim() &&
          refs.trim() !== `refs/heads/${branch} ${repo.baseCommit}`
        )
          throw new Error(
            "Existing session branch differs from the starting commit",
          );
        await this.git(store, [
          "worktree",
          "add",
          ...(refs.trim() ? [] : ["-b", branch]),
          "--",
          path,
          refs.trim() ? branch : repo.baseCommit,
        ]);
        await this.validateWorktree(store, path);
      } catch {
        throw new Error(
          `${repo.key}: 作業ツリーの準備に失敗しました。既存ファイルは上書きしていません`,
        );
      }
    }
  }
  async update(
    repositories: unknown,
  ): Promise<{ key: string; ok: boolean; error?: string }[]> {
    const results = [];
    for (const repo of repositoryBindings.parse(repositories)) {
      try {
        const { store } = this.paths(repo);
        if (await lstat(store).catch(absent)) {
          await this.validateStore(store);
          await this.fetch(store, repo);
        } else await this.ensureStore(repo);
        results.push({ key: repo.key, ok: true });
      } catch {
        results.push({ key: repo.key, ok: false, error: "取得に失敗しました" });
      }
    }
    return results;
  }
  async remove(repositories: unknown): Promise<void> {
    for (const repo of repositoryBindings.parse(repositories)) {
      const { store, path } = this.paths(repo);
      await directory(dirname(path));
      if (!(await directory(store))) {
        if (await lstat(path).catch(absent))
          throw new Error("Shared store missing for an existing worktree");
        continue;
      }
      await this.validateStore(store);
      if (await lstat(path).catch(absent)) {
        await this.validateWorktree(store, path);
        await this.git(store, ["worktree", "remove", "--force", "--", path]);
      } else if (await this.registered(store, path)) {
        await this.validateMissingRegistration(store, path);
        // Git removes only this exact missing worktree registration, never a global prune.
        await this.git(store, ["worktree", "remove", "--", path]);
      }
      if (await this.registered(store, path))
        throw new Error("Worktree removal was not confirmed");
    }
  }
}
