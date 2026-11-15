import { lstat, readFile, opendir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export const worktreePlan = z
  .array(
    z
      .object({
        path: z.string().max(4096),
        store: z.string().max(4096),
      })
      .strict(),
  )
  .max(1000);
type Target = z.infer<typeof worktreePlan>[number];
type Git = (args: string[]) => Promise<string>;
const absent = (error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
};
const within = (path: string, base: string) =>
  path === base || path.startsWith(base + "/");

async function directory(path: string): Promise<boolean> {
  if (path === "/") return true;
  if (!(await directory(dirname(path)))) return false;
  const info = await lstat(path).catch(absent);
  if (!info) return false;
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path
  )
    throw new Error("Worktree directory was replaced");
  return true;
}
async function textFile(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 65536)
    throw new Error("Unsafe Git metadata");
  return readFile(path, "utf8");
}

/** Only session deletion uses this helper. Git creation, fetching and editing stay ordinary tools. */
export class Worktrees {
  private base: string;
  constructor(
    private root: string,
    id: string,
    private git: Git,
    private signal: AbortSignal,
  ) {
    this.base = join(root, "conversations", z.string().uuid().parse(id));
  }
  private allowedStore(path: string) {
    return (
      ["shared", "home", "repositories"].some((name) =>
        within(path, join(this.root, name)),
      ) || within(path, this.base)
    );
  }
  private validateTarget(target: Target) {
    if (
      !within(target.path, this.base) ||
      !this.allowedStore(target.store) ||
      target.path !== resolve(target.path) ||
      target.store !== resolve(target.store)
    )
      throw new Error("Worktree is outside the deletion scope");
  }
  private async registrations(store: string) {
    if (!(await directory(store))) throw new Error("Git store is missing");
    await textFile(join(store, "HEAD"));
    await textFile(join(store, "config"));
    const output = await this.git([
      "--git-dir",
      store,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    return output
      .split("\0")
      .filter((part) => part.startsWith("worktree "))
      .map((part) => part.slice(9));
  }
  private async validateRegistration(target: Target) {
    this.validateTarget(target);
    if (!(await directory(target.store)))
      throw new Error("Git store is missing");
    const registrations = join(target.store, "worktrees");
    if (!(await directory(registrations)))
      throw new Error("Worktree registration is missing");
    let scanned = 0;
    let admin: string | undefined;
    for await (const { name } of await opendir(registrations)) {
      if (++scanned > 1000) throw new Error("Too many worktree registrations");
      this.signal.throwIfAborted();
      const candidate = join(registrations, name);
      await directory(candidate);
      if (
        resolve(
          candidate,
          (await textFile(join(candidate, "gitdir"))).trim(),
        ) !== join(target.path, ".git")
      )
        continue;
      if (
        admin ||
        resolve(
          candidate,
          (await textFile(join(candidate, "commondir"))).trim(),
        ) !== target.store
      )
        throw new Error("Ambiguous worktree registration");
      await textFile(join(candidate, "HEAD"));
      admin = candidate;
    }
    if (!admin) throw new Error("Worktree registration is missing");
    if (await lstat(target.path).catch(absent)) {
      await directory(target.path);
      const pointer = (await textFile(join(target.path, ".git"))).trim();
      if (
        !pointer.startsWith("gitdir: ") ||
        resolve(target.path, pointer.slice(8)) !== admin
      )
        throw new Error("Worktree points to another store");
    } else {
      // Validate existing parents without requiring a directory removed by an interrupted Git command.
      await directory(dirname(target.path));
    }
  }
  async plan(legacyRepositories: unknown = []): Promise<Target[]> {
    const targets = new Map<string, Target>();
    const stores = new Set<string>();
    const inspectStore = async (store: string) => {
      if (stores.has(store)) return;
      stores.add(store);
      if (!this.allowedStore(store) || store !== resolve(store))
        throw new Error("Git store is outside work storage");
      const paths = await this.registrations(store);
      if (
        within(store, this.base) &&
        paths.some((path) => !within(path, this.base))
      )
        throw new Error(
          "Session repository has worktrees outside this session",
        );
      for (const path of paths) {
        if (!within(path, this.base)) continue;
        // The main working tree owns its .git directory and is removed with the session.
        const metadata = await lstat(join(path, ".git")).catch(absent);
        if (metadata?.isDirectory() && join(path, ".git") === store) continue;
        const target = { path, store };
        await this.validateRegistration(target);
        if (targets.has(path) && targets.get(path)!.store !== store)
          throw new Error("Ambiguous worktree store");
        targets.set(path, target);
        if (targets.size > 1000) throw new Error("Too many session worktrees");
      }
    };
    let scanned = 0;
    const walk = async (
      path: string,
      session: boolean,
      depth = 0,
    ): Promise<void> => {
      this.signal.throwIfAborted();
      if (++scanned > 100000 || depth > 64)
        throw new Error("Worktree discovery limit exceeded");
      const info = await lstat(path).catch(absent);
      if (!info || info.isSymbolicLink() || !info.isDirectory()) return;
      await directory(path);
      const metadata = await lstat(join(path, ".git")).catch(absent);
      if (metadata) {
        if (metadata.isDirectory()) await inspectStore(join(path, ".git"));
        else {
          const pointer = (await textFile(join(path, ".git"))).trim();
          if (!pointer.startsWith("gitdir: "))
            throw new Error("Unsupported Git pointer");
          const admin = resolve(path, pointer.slice(8));
          if (!this.allowedStore(admin))
            throw new Error("Git metadata is outside work storage");
          await directory(admin);
          await inspectStore(
            resolve(admin, (await textFile(join(admin, "commondir"))).trim()),
          );
        }
        if (!session) return;
      } else if (
        (await lstat(join(path, "HEAD")).catch(absent)) &&
        (await lstat(join(path, "objects")).catch(absent))
      ) {
        await inspectStore(path);
        return;
      }
      for await (const item of await opendir(path)) {
        this.signal.throwIfAborted();
        if (++scanned > 100000)
          throw new Error("Worktree discovery limit exceeded");
        if (item.isDirectory() && item.name !== ".git")
          await walk(join(path, item.name), session, depth + 1);
      }
    };
    // Persisted bindings also locate old registrations whose working directory is already gone.
    for (const repo of z
      .array(
        z
          .object({
            key: z.string().regex(/^github\.com\/[a-z0-9-]+\/[a-z0-9_.-]+$/),
          })
          .passthrough(),
      )
      .max(1000)
      .parse(legacyRepositories)) {
      if (repo.key.split("/").some((part) => part === "." || part === ".."))
        throw new Error("Invalid legacy repository key");
      const store = join(this.root, "repositories", `${repo.key}.git`);
      if (await directory(store)) await inspectStore(store);
    }
    for (const name of ["shared", "home/repos", "repositories"])
      await walk(join(this.root, name), false);
    await directory(dirname(this.base));
    await walk(this.base, true);
    return [...targets.values()].sort((a, b) => b.path.length - a.path.length);
  }
  async remove(value: unknown) {
    for (const target of worktreePlan.parse(value)) {
      this.signal.throwIfAborted();
      this.validateTarget(target);
      const paths = await this.registrations(target.store);
      if (!paths.includes(target.path)) {
        if (await lstat(target.path).catch(absent))
          throw new Error("Existing worktree is no longer registered");
        continue;
      }
      await this.validateRegistration(target);
      await this.git([
        "--git-dir",
        target.store,
        "worktree",
        "remove",
        "--force",
        "--",
        target.path,
      ]);
      if ((await this.registrations(target.store)).includes(target.path))
        throw new Error("Worktree removal was not confirmed");
    }
  }
}
