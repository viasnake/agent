import type { UsageState } from "@earendil-works/pi-durable";

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

// Pi owns cumulative accounting, including compaction and fork isolation. Do not
// reconstruct spend from the visible transcript or reprice past calls.
export function conversationUsage(
  state: Readonly<UsageState> | undefined,
): ConversationUsage {
  const rows = (bucket: UsageState["models"]) =>
    Object.entries(bucket).map(([name, usage]) => ({
      name,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      totalTokens: usage.totalTokens,
      // Pi's cumulative zero does not distinguish free usage from missing prices.
      // Its totalFromProvider flag is not maintained when subsequent calls are added.
      cost:
        usage.totalTokens > 0 && usage.cost.total === 0
          ? null
          : usage.cost.total,
    }));
  const models = rows(state?.models ?? {});
  const tools = rows(state?.tools ?? {});
  const total: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
  for (const row of [...models, ...tools]) {
    total.input += row.input;
    total.output += row.output;
    total.cacheRead += row.cacheRead;
    total.cacheWrite += row.cacheWrite;
    total.totalTokens += row.totalTokens;
    total.cost =
      total.cost === null || row.cost === null ? null : total.cost + row.cost;
  }
  return { total, models, tools };
}
