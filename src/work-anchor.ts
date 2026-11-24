import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { Runner } from "./execution/protocol.js";
import { WorkerCleanupError } from "./execution/client.js";
import { AppError, byteHash, hash } from "./security.js";
import {
  gitWorkInput,
  gitWorkResult,
  planInput,
  replacement,
  workView,
  WorkDoc,
  type Work,
  type Plan,
} from "./parallel-work.js";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ConversationsDoc } from "./state.js";
type Generate = (
  prompt: string,
  signal: AbortSignal,
) => Promise<AssistantMessage>;
type ResponseBudget = { deadline: number; limit: number };
type Options = {
  harness: () => Harness;
  runner: Runner;
  notify: () => void;
  fatal: () => void;
  redact: (text: string) => string;
  bind: (
    id: string,
    work: Work,
    signal: AbortSignal,
    reserve: () => Promise<void>,
  ) => Promise<Generate>;
};
type Live = { id: string; controller: AbortController; done: Promise<void> };
type Owner = { id: string; piId: ConversationId };
export const retryInput = z
  .object({
    id: z.uuid(),
    path: z.string().min(1).max(220).optional(),
    guidance: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
const activeStates = new Set(["running", "pausing", "cancelling"]);
function stopClock(work: Work) {
  if (work.startedAt !== undefined) {
    work.remainingMs = Math.max(
      0,
      work.remainingMs - Math.max(0, Date.now() - work.startedAt),
    );
    delete work.startedAt;
  }
}
function interruptOpen(work: Work) {
  for (const a of work.assignments) {
    const last = a.attempts.at(-1);
    if (last?.state === "running") last.state = "interrupted";
  }
  for (const c of work.candidates)
    for (const check of c.checks)
      if (check.status === "running") check.status = "interrupted";
}
export class WorkAnchor {
  private closing = false;
  private readonly live = new Map<string, Live>();
  constructor(private options: Options) {}
  get busy() {
    return this.live.size > 0;
  }
  private async items(owner: Owner) {
    return (
      (await this.options.harness().snapshot(WorkDoc, owner.piId, ctx))
        ?.items ?? []
    );
  }
  async view(owner: Owner) {
    return (await this.items(owner)).map(workView);
  }
  private async read(owner: Owner, id: string) {
    const item = (await this.items(owner)).find((work) => work.id === id);
    if (!item) throw new AppError(404, "作業がありません");
    return item;
  }
  private async change<T>(owner: Owner, id: string, fn: (work: Work) => T) {
    const result = await this.options.harness().commit(async (tx) => {
      const work = (await tx.doc(WorkDoc, owner.piId)).items.find(
        (work) => work.id === id,
      );
      if (!work) throw new AppError(404, "作業がありません");
      return fn(work);
    }, ctx);
    this.options.notify();
    return result;
  }
  async recover(owner: Owner) {
    for (const item of await this.items(owner))
      if (activeStates.has(item.status)) {
        await this.change(owner, item.id, (work) => {
          stopClock(work);
          interruptOpen(work);
          work.status = work.status === "cancelling" ? "cancelled" : "paused";
          work.detail = "再起動により中断しました。履歴を確認してください";
        });
      }
  }
  // Call admission and control methods under the service admission lock. Waiting never holds it.
  async start(
    owner: Owner,
    plan: Plan,
    connection: string | undefined,
    model: string,
    budget: ResponseBudget,
    remainingCalls: number,
    checkSeconds: number,
  ) {
    if (this.closing) throw new AppError(503, "サービスを停止しています");
    plan = planInput.parse(plan);
    for (const value of [
      plan.repo,
      plan.goal,
      plan.check,
      ...plan.assignments.flatMap((a) => [a.instruction, a.path]),
    ])
      this.exposable(value);
    const id = randomUUID();
    await this.options.harness().commit(async (tx) => {
      const doc = await tx.doc(WorkDoc, owner.piId);
      if (
        this.live.has(owner.id) ||
        doc.items.some((work) => !["passed", "cancelled"].includes(work.status))
      )
        throw new AppError(409, "前の並列作業を完了または取り消してください");
      if (doc.items.length >= 12 || remainingCalls < 2)
        throw new AppError(409, "並列作業の上限に達しました");
      doc.items.push({
        id,
        plan,
        model,
        ...(connection ? { connection } : {}),
        status: "running",
        detail: "",
        assignments: [{ attempts: [] }, { attempts: [] }],
        candidates: [],
        calls: 0,
        maxCalls: Math.min(8, remainingCalls),
        remainingMs: Math.max(0, budget.deadline - Date.now()),
        startedAt: Date.now(),
        checkSeconds: Math.min(300, checkSeconds),
      });
    }, ctx);
    this.launch(owner, id, budget);
    return id;
  }
  async resume(
    owner: Owner,
    args: z.infer<typeof retryInput>,
    budget?: ResponseBudget,
  ) {
    if (this.closing) throw new AppError(503, "サービスを停止しています");
    const { id, path, guidance } = args;
    if (guidance) this.exposable(guidance);
    if (this.live.has(owner.id))
      throw new AppError(409, "作業の終了を待ってください");
    await this.change(owner, id, (work) => {
      if (!["paused", "failed"].includes(work.status))
        throw new AppError(409, "再開できない作業です");
      const i = path
        ? work.plan.assignments.findIndex((a) => a.path === path)
        : -1;
      if ((path && i < 0) || (guidance && !path))
        throw new AppError(400, "修正対象の担当ファイルを指定してください");
      if (work.remainingMs <= 0)
        throw new AppError(409, "並列作業の実行時間を使い切りました");
      if (i >= 0) {
        if (work.calls >= work.maxCalls)
          throw new AppError(409, "担当のモデル呼び出し上限に達しました");
        const attempts = work.assignments[i]!.attempts;
        if (attempts.length >= 8)
          throw new AppError(409, "担当の再試行上限に達しました");
        attempts.push({
          number: attempts.length + 1,
          state: "queued",
          ...(guidance ? { guidance } : {}),
        });
        delete work.selected;
      }
      work.status = "running";
      work.detail = "";
      work.startedAt = Date.now();
    });
    this.launch(owner, id, budget);
  }
  async control(owner: Owner, id: string, action: "pause" | "cancel") {
    await this.change(owner, id, (work) => {
      if (
        (work.status === "cancelled" && action === "cancel") ||
        (work.status === "paused" && action === "pause")
      )
        return;
      if (["passed", "cancelled"].includes(work.status))
        throw new AppError(409, "終了した作業です");
      if (action === "pause") {
        if (!["running", "pausing"].includes(work.status))
          throw new AppError(409, "実行中の作業を指定してください");
        work.status = "pausing";
      } else
        work.status =
          this.live.get(owner.id)?.id === id ? "cancelling" : "cancelled";
    });
    if (action === "cancel" && this.live.get(owner.id)?.id === id)
      this.live.get(owner.id)!.controller.abort();
  }
  async wait(owner: Owner, id: string) {
    const run = this.live.get(owner.id);
    if (run?.id === id) await run.done;
    return workView(await this.read(owner, id));
  }
  async download(owner: Owner, id: string, candidate: string) {
    const work = await this.read(owner, id);
    const c = work.candidates.find(
      (c) =>
        c.id === candidate &&
        c.checks.some((check) => check.status === "passed"),
    );
    if (
      !c ||
      hash({
        base: work.plan.base,
        tree: c.tree,
        patch: byteHash(Buffer.from(c.patch)),
      }) !== candidate
    )
      throw new AppError(404, "検証済みの差分がありません");
    return Buffer.from(c.patch);
  }
  async close() {
    this.closing = true;
    const all = [...this.live.values()];
    for (const run of all) run.controller.abort();
    await Promise.all(all.map((run) => run.done));
  }
  private exposable(text: string) {
    if (this.options.redact(text) !== text)
      throw new Error("保存または送信できない値が含まれています");
    return text;
  }
  private launch(owner: Owner, id: string, budget?: ResponseBudget) {
    const controller = new AbortController();
    const done = this.execute(owner, id, controller.signal, budget)
      .catch(async (error: unknown) => {
        if (error instanceof WorkerCleanupError) {
          this.options.fatal();
          return;
        }
        await this.change(owner, id, (work) => {
          stopClock(work);
          interruptOpen(work);
          if (work.status === "cancelling") work.status = "cancelled";
          else if (work.status === "pausing" || controller.signal.aborted)
            work.status = "paused";
          else work.status = "failed";
          work.detail =
            work.status === "failed"
              ? this.options.redact(
                  error instanceof AppError
                    ? error.message
                    : "処理に失敗しました。基点・対象ファイル・検証結果を確認してください",
                )
              : "";
        });
      })
      .catch(() => this.options.fatal())
      .finally(() => {
        this.live.delete(owner.id);
        this.options.notify();
      });
    this.live.set(owner.id, { id, controller, done });
    this.options.notify();
  }
  private async execute(
    owner: Owner,
    id: string,
    stop: AbortSignal,
    budget?: ResponseBudget,
  ) {
    const initial = await this.read(owner, id);
    const signal = AbortSignal.any([
      stop,
      AbortSignal.timeout(
        Math.max(1, initial.remainingMs - (Date.now() - initial.startedAt!)),
      ),
    ]);
    const { plan } = initial;
    const boundary = async () => {
      signal.throwIfAborted();
      const work = await this.read(owner, id);
      if (work.status !== "running") throw new Error("Dispatch stopped");
      return work;
    };
    const git = async (request: z.infer<typeof gitWorkInput>) => {
      await boundary();
      const reply = await this.options.runner.call(
        owner.id,
        "parallel_work",
        request,
        request.kind === "check"
          ? AbortSignal.any([
              signal,
              AbortSignal.timeout((request.seconds + 5) * 1000),
            ])
          : signal,
      );
      signal.throwIfAborted();
      return gitWorkResult.parse(reply.parallelWork);
    };
    const pending = initial.assignments.flatMap((a, i) =>
      a.attempts.at(-1)?.state === "ready" ? [] : [i],
    );
    if (pending.length) {
      if (initial.calls + pending.length > initial.maxCalls)
        throw new AppError(409, "モデル呼び出しの上限に達しました");
      const sources = await git({
        kind: "sources",
        repo: plan.repo,
        base: plan.base,
        paths: plan.assignments.map((a) => a.path),
      });
      if (sources.kind !== "sources")
        throw new Error("Missing source snapshot");
      for (const file of sources.files) if (file !== null) this.exposable(file);
      const generate = await this.options.bind(
        owner.id,
        initial,
        signal,
        async () => {
          signal.throwIfAborted();
          await this.options.harness().commit(async (tx) => {
            const work = (await tx.doc(WorkDoc, owner.piId)).items.find(
              (work) => work.id === id,
            )!;
            if (
              work.status !== "running" ||
              work.calls >= work.maxCalls ||
              signal.aborted
            )
              throw new Error("Dispatch stopped");
            if (budget) {
              const row = (await tx.doc(ConversationsDoc)).conversations.find(
                (c) => c.id === owner.id,
              )!;
              if (
                row.status === "running" &&
                row.deadlineAt === budget.deadline
              ) {
                if (row.requests >= budget.limit)
                  throw new Error("Response dispatch limit reached");
                row.requests++;
              }
            }
            work.calls++;
          }, ctx);
        },
      );
      const results = await Promise.allSettled(
        pending.map(async (i) => {
          const a = plan.assignments[i]!;
          const input = await this.change(owner, id, (work) => {
            if (work.status !== "running") throw new Error("Dispatch stopped");
            const attempts = work.assignments[i]!.attempts;
            const last = attempts.at(-1);
            if (last?.state === "queued") last.state = "running";
            else {
              if (attempts.length >= 8)
                throw new AppError(409, "担当の再試行上限に達しました");
              attempts.push({
                number: attempts.length + 1,
                state: "running",
                ...(last?.guidance ? { guidance: last.guidance } : {}),
              });
            }
            return {
              guidance: attempts.at(-1)?.guidance ?? "",
              previous:
                attempts.findLast((attempt) => attempt.state === "ready")
                  ?.content ?? null,
            };
          });
          try {
            const response = await generate(
              JSON.stringify({
                goal: plan.goal,
                assignment: a,
                source: sources.files[i],
                ...input,
              }),
              signal,
            );
            await this.change(owner, id, (work) => {
              work.assignments[i]!.attempts.at(-1)!.usage = {
                time: Date.now(),
                model: response.provider + "/" + response.model,
                tokens: response.usage,
                error: response.stopReason !== "stop",
              };
            });
            signal.throwIfAborted();
            if (response.stopReason !== "stop")
              throw new Error("Incomplete assignment");
            const text = response.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("");
            const { content } = replacement.parse(JSON.parse(text));
            if (content !== null) this.exposable(content);
            await this.change(owner, id, (work) => {
              const attempt = work.assignments[i]!.attempts.at(-1)!;
              attempt.state = "ready";
              attempt.content = content;
            });
          } catch (error) {
            await this.change(owner, id, (work) => {
              const attempt = work.assignments[i]!.attempts.at(-1)!;
              attempt.state = signal.aborted ? "interrupted" : "failed";
              attempt.detail = "担当の変更を取得できませんでした";
            });
            throw error;
          }
        }),
      );
      if (results.some((r) => r.status === "rejected"))
        throw new AppError(
          409,
          "未完了の担当があります。成功した担当の変更は保存しました",
        );
    }
    let work = await boundary();
    let candidate = work.candidates.find((c) => c.id === work.selected);
    if (!candidate) {
      const edits = work.assignments.map((a, i) => ({
        path: plan.assignments[i]!.path,
        content: a.attempts.at(-1)!.content!,
      }));
      const result = await git({
        kind: "candidate",
        repo: plan.repo,
        base: plan.base,
        edits,
      });
      if (result.kind !== "candidate") throw new Error("Missing candidate");
      const patch = this.exposable(result.patch);
      const key = hash({
        base: plan.base,
        tree: result.tree,
        patch: byteHash(Buffer.from(patch)),
      });
      await this.change(owner, id, (work) => {
        if (!work.candidates.some((c) => c.id === key))
          work.candidates.push({
            id: key,
            tree: result.tree,
            patch,
            attempts: work.assignments.map((a) => a.attempts.at(-1)!.number),
            checks: [],
          });
        work.selected = key;
      });
      work = await boundary();
      candidate = work.candidates.find((c) => c.id === key)!;
    }
    const key = candidate.id;
    await this.change(owner, id, (work) => {
      if (work.status !== "running") throw new Error("Dispatch stopped");
      const c = work.candidates.find((c) => c.id === key)!;
      if (c.checks.length >= 8)
        throw new AppError(409, "この成果の検証回数が上限に達しました");
      c.checks.push({ status: "running", output: "" });
    });
    const check = await git({
      kind: "check",
      repo: plan.repo,
      base: plan.base,
      tree: candidate.tree,
      patch: candidate.patch,
      command: plan.check,
      seconds: work.checkSeconds,
    });
    if (check.kind !== "check") throw new Error("Missing check");
    await this.change(owner, id, (work) => {
      if (work.status === "cancelling" || signal.aborted)
        throw new Error("Check interrupted");
      const c = work.candidates.find((c) => c.id === key)!;
      const result = c.checks.at(-1)!;
      result.status = check.passed ? "passed" : "failed";
      result.output = this.options.redact(check.output).slice(-4000);
      stopClock(work);
      work.status = check.passed ? "passed" : "failed";
      work.detail = check.passed ? "" : "検証に失敗しました";
    });
  }
}
