import { ProjectEvidenceDoc, type MemberUsage } from "./projects.js";
import { assignmentUsage, WorkDoc, type Work } from "./parallel-work.js";
import type { Usage } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  ToolResultEntry,
  type ConversationId,
  type Cursor,
  type Harness,
  type UsageState,
} from "@earendil-works/pi-durable";
import { AppError } from "./security.js";

export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number | null;
};
export type ConversationUsage = {
  total: UsageTotals;
  models: (UsageTotals & { name: string })[];
  tools: (UsageTotals & { name: string })[];
};
export type ActivityRow = UsageTotals & {
  name: string;
  calls: number;
  errors: number;
  label?: string;
};
export type DailyUsage = {
  date: string;
  modelCalls: number;
  toolCalls: number;
  toolErrors: number;
  totalTokens: number;
};
export type RecordedUsage = {
  models: ActivityRow[];
  tools: ActivityRow[];
  total: UsageTotals;
  days: DailyUsage[];
};
export type UsagePeriod = { from: string; to: string; timezone: string };

function emptyTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
}

function usageTotals(usage: Usage): UsageTotals {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    // Pi's cumulative zero does not distinguish free usage from missing prices.
    // Its totalFromProvider flag is not maintained when subsequent calls are added.
    cost:
      usage.totalTokens > 0 && usage.cost.total === 0 ? null : usage.cost.total,
  };
}

function addTotals(total: UsageTotals, row: UsageTotals): void {
  total.input += row.input;
  total.output += row.output;
  total.cacheRead += row.cacheRead;
  total.cacheWrite += row.cacheWrite;
  total.totalTokens += row.totalTokens;
  total.cost =
    total.cost === null || row.cost === null ? null : total.cost + row.cost;
}

// Pi owns cumulative accounting, including compaction and fork isolation.
export function conversationUsage(
  state: Readonly<UsageState> | undefined,
  work: readonly Work[] = [],
  team: readonly MemberUsage[] = [],
): ConversationUsage {
  const rows = (bucket: UsageState["models"]) =>
    Object.entries(bucket).map(([name, usage]) => ({
      name,
      ...usageTotals(usage),
    }));
  const models = rows(state?.models ?? {});
  for (const a of [...assignmentUsage(work), ...team]) {
    const row = models.find((m) => m.name === a.model);
    if (row) addTotals(row, usageTotals(a.tokens));
    else models.push({ name: a.model, ...usageTotals(a.tokens) });
  }
  const tools = rows(state?.tools ?? {});
  const total = emptyTotals();
  for (const row of [...models, ...tools]) addTotals(total, row);
  return { total, models, tools };
}

export async function recordedUsage(
  harness: Harness,
  conversations: readonly ConversationId[],
  context: Context,
  labels: ReadonlyMap<string, string>,
  period?: UsagePeriod,
): Promise<RecordedUsage> {
  let dateOf: Intl.DateTimeFormat | undefined;
  if (period) {
    if (period.from > period.to)
      throw new AppError(400, "開始日は終了日以前にしてください");
    try {
      dateOf = new Intl.DateTimeFormat("sv-SE", {
        timeZone: period.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      throw new AppError(400, "タイムゾーンが不正です");
    }
  }
  const models = new Map<string, ActivityRow>();
  const tools = new Map<string, ActivityRow>();
  const days = new Map<string, DailyUsage>();
  function record(
    model: boolean,
    name: string,
    timestamp: number,
    error: boolean,
    usage?: Usage,
    label?: string,
  ) {
    let day: DailyUsage | undefined;
    if (period && dateOf) {
      if (!Number.isFinite(timestamp)) return;
      const date = dateOf.format(timestamp);
      if (date < period.from || date > period.to) return;
      day = days.get(date) ?? {
        date,
        modelCalls: 0,
        toolCalls: 0,
        toolErrors: 0,
        totalTokens: 0,
      };
      days.set(date, day);
    }
    const bucket = model ? models : tools;
    const row: ActivityRow = bucket.get(name) ?? {
      name,
      calls: 0,
      errors: 0,
      ...emptyTotals(),
    };
    if (label && !row.label) row.label = label;
    row.calls++;
    if (error) row.errors++;
    if (usage) addTotals(row, usageTotals(usage));
    bucket.set(name, row);
    if (day) {
      if (model) day.modelCalls++;
      else {
        day.toolCalls++;
        if (error) day.toolErrors++;
      }
      day.totalTokens += usage?.totalTokens ?? 0;
    }
  }
  for (const id of conversations) {
    for (const a of [
      ...assignmentUsage(
        (await harness.snapshot(WorkDoc, id, context))?.items ?? [],
      ),
      ...((await harness.snapshot(ProjectEvidenceDoc, id, context))?.usage ??
        []),
    ])
      record(true, a.model, a.time, a.error, a.tokens);
    const pi = await harness.conversation(id, context);
    if (!pi) throw new AppError(503, "保存されたスレッドがありません");
    let cursor: Cursor | undefined;
    // A fork's own entries come after its ancestor's entries, even after compaction.
    scan: do {
      const page = await pi.entries(
        { order: "descending" },
        20,
        cursor,
        context,
      );
      for (const entry of page.items) {
        if (entry.conversationId !== id) break scan;
        const message = entry.model?.[0];
        if (message?.role !== "assistant" && message?.role !== "toolResult")
          continue;
        const model = message.role === "assistant";
        if (!(model ? AssistantEntry.is(entry) : ToolResultEntry.is(entry)))
          continue;
        const name = model
          ? `${message.provider}/${message.model}`
          : message.toolName;
        const error = model
          ? message.stopReason === "error" || message.stopReason === "aborted"
          : message.isError;
        let label: string | undefined;
        if (!model && name.startsWith("mcp_")) {
          const d = message.details;
          const saved =
            d &&
            typeof d === "object" &&
            "agentMcpToolLabel" in d &&
            d.agentMcpToolLabel;
          label = typeof saved === "string" ? saved : labels.get(name);
        }
        record(model, name, message.timestamp, error, message.usage, label);
      }
      cursor = page.next;
    } while (cursor);
  }
  const total = emptyTotals();
  for (const row of models.values()) addTotals(total, row);
  for (const row of tools.values()) addTotals(total, row);
  const sorted = (rows: Map<string, ActivityRow>) =>
    [...rows.values()].sort(
      (a, b) => b.calls - a.calls || a.name.localeCompare(b.name),
    );
  return {
    models: sorted(models),
    tools: sorted(tools),
    total,
    days: [...days.values()].sort((a, b) => b.date.localeCompare(a.date)),
  };
}
