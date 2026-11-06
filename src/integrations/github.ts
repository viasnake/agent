import { z } from "zod";
import { AppError, hash, safeRelative } from "../security.js";
import type { GithubPayload, Operation } from "../state.js";
export const githubPayloadSchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    branch: z.string().regex(/^codex\/job-[a-f0-9-]{36}$/),
    base: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_/-]{0,100}$/)
      .refine((s) => !s.includes("..")),
    baseSha: z.string().regex(/^[a-f0-9]{40}$/),
    title: z.string().min(1).max(200),
    body: z.string().max(20000),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(240),
            content: z.string().max(2 * 1024 * 1024),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type GithubTransport = (
  path: string,
  method: string,
  body?: unknown,
) => Promise<unknown>;
export class GithubConnector {
  constructor(
    readonly repositories: string[],
    private request: GithubTransport,
  ) {}
  validate(payload: GithubPayload, jobId: string): void {
    githubPayloadSchema.parse(payload);
    if (
      !this.repositories.includes(payload.repository) ||
      payload.branch !== `codex/job-${jobId}`
    )
      throw new AppError(
        403,
        "許可されたリポジトリと仕事専用ブランチに限定されています",
      );
    if (Buffer.byteLength(JSON.stringify(payload)) > 4 * 1024 * 1024)
      throw new AppError(413, "GitHub 操作が大きすぎます");
    const paths = new Set<string>();
    for (const file of payload.files) {
      safeRelative(file.path);
      if (file.path.split("/").includes(".git") || paths.has(file.path))
        throw new AppError(400, "Git の内部ファイル・重複パスは指定できません");
      paths.add(file.path);
    }
  }
  private marker(operation: Operation): string {
    return `agent-operation:${operation.id}:${operation.argumentHash}`;
  }
  async execute(operation: Operation): Promise<string> {
    const payload = operation.payload!;
    this.validate(payload, operation.jobId);
    if (hash(payload) !== operation.argumentHash)
      throw new AppError(409, "承認内容が変更されています");
    const repo = `/repos/${payload.repository}`,
      sha = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) });
    const branchPath = payload.branch
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    // Only create a new dedicated branch. Existing refs are a conflict, never a force-push target.
    try {
      await this.request(`${repo}/git/ref/heads/${branchPath}`, "GET");
      throw new AppError(409, "専用ブランチが既に存在します。照合してください");
    } catch (error) {
      if (!(error instanceof AppError) || error.statusCode !== 404) throw error;
    }
    const base = z
      .object({ sha: z.string(), tree: z.object({ sha: z.string() }) })
      .parse(
        await this.request(`${repo}/git/commits/${payload.baseSha}`, "GET"),
      );
    if (base.sha !== payload.baseSha)
      throw new AppError(409, "基準 commit が一致しません");
    const tree: { path: string; mode: string; type: string; sha: string }[] =
      [];
    for (const file of payload.files) {
      const blob = sha.parse(
        await this.request(`${repo}/git/blobs`, "POST", {
          content: Buffer.from(file.content).toString("base64"),
          encoding: "base64",
        }),
      );
      tree.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }
    const createdTree = sha.parse(
      await this.request(`${repo}/git/trees`, "POST", {
        base_tree: base.tree.sha,
        tree,
      }),
    );
    const commit = sha.parse(
      await this.request(`${repo}/git/commits`, "POST", {
        message: `${payload.title}\n\n${this.marker(operation)}`,
        tree: createdTree.sha,
        parents: [payload.baseSha],
      }),
    );
    await this.request(`${repo}/git/refs`, "POST", {
      ref: `refs/heads/${payload.branch}`,
      sha: commit.sha,
    });
    const pr = z.object({ number: z.number().int() }).parse(
      await this.request(`${repo}/pulls`, "POST", {
        title: payload.title,
        body: `${payload.body}\n\n<!-- ${this.marker(operation)} -->`,
        head: payload.branch,
        base: payload.base,
        draft: true,
      }),
    );
    return String(pr.number);
  }
  async reconcile(operation: Operation): Promise<string | null> {
    const payload = operation.payload!;
    this.validate(payload, operation.jobId);
    const repo = `/repos/${payload.repository}`;
    const query = new URLSearchParams({
      state: "all",
      head: `${payload.repository.split("/")[0]}:${payload.branch}`,
      base: payload.base,
      per_page: "100",
    });
    const results = z
      .array(
        z.object({
          number: z.number().int(),
          body: z.string().nullable(),
          head: z.object({ ref: z.string(), sha: z.string() }),
          base: z.object({ ref: z.string() }),
        }),
      )
      .parse(await this.request(`${repo}/pulls?${query}`, "GET"));
    const matches = results.filter(
      (pr) =>
        pr.head.ref === payload.branch &&
        pr.base.ref === payload.base &&
        pr.body?.includes(`<!-- ${this.marker(operation)} -->`),
    );
    if (matches.length !== 1) return null;
    const commit = z
      .object({ message: z.string() })
      .parse(
        await this.request(
          `${repo}/git/commits/${matches[0]!.head.sha}`,
          "GET",
        ),
      );
    if (!commit.message.includes(this.marker(operation))) return null;
    return String(matches[0]!.number);
  }
}
export function githubHttp(token: string): GithubTransport {
  return async (path, method, body) => {
    if (!path.startsWith("/repos/") || path.includes(".."))
      throw new AppError(403, "GitHub パスが不正です");
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new AppError(response.status, "GitHub 操作を確認できません");
    if (!response.body) throw new AppError(503, "GitHub 応答が空です");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          throw new AppError(503, "GitHub 応答が上限を超えています");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  };
}
