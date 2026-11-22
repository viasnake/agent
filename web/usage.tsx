import type {
  ActivityRow,
  ConversationUsage,
  RecordedUsage,
  UsageTotals,
} from "../src/usage.js";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api.js";
import { Icon } from "./icons.js";

const numbers = new Intl.NumberFormat("ja-JP");
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 6,
  maximumFractionDigits: 6,
});

function cost(value: number | null) {
  return value === null ? "N/A" : dollars.format(value);
}

function count(value?: number) {
  return value === undefined ? "—" : numbers.format(value);
}

function UsageRow({
  name,
  usage,
  calls,
  errors,
}: {
  name: string;
  usage: UsageTotals;
  calls?: number;
  errors?: number;
}) {
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>{count(calls)}</td>
      <td>{count(errors)}</td>
      <td>{numbers.format(usage.input)}</td>
      <td>{numbers.format(usage.output)}</td>
      <td>{numbers.format(usage.cacheRead)}</td>
      <td>{numbers.format(usage.cacheWrite)}</td>
      <td>{numbers.format(usage.totalTokens)}</td>
      <td>{cost(usage.cost)}</td>
    </tr>
  );
}

function UsageRows({
  usage,
  activity,
  tool = false,
}: {
  usage: ConversationUsage["models"];
  activity?: ActivityRow[];
  tool?: boolean;
}) {
  const rows = new Map(usage.map((row) => [row.name, row]));
  const counts = new Map(activity?.map((row) => [row.name, row]));
  // Include calls whose results carry no token usage, such as bash and file tools.
  for (const [name, row] of counts) if (!rows.has(name)) rows.set(name, row);
  return [...rows].map(([name, row]) => {
    const item = counts.get(name);
    return (
      <UsageRow
        key={name}
        name={tool ? `ツール: ${item?.label ?? name}` : name}
        usage={row}
        calls={item?.calls}
        errors={item?.errors}
      />
    );
  });
}

function UsageSummary({
  usage,
  activity,
}: {
  usage: UsageTotals;
  activity?: RecordedUsage;
}) {
  return (
    <dl className="usage-summary">
      <div>
        <dt>合計トークン</dt>
        <dd>{numbers.format(usage.totalTokens)}</dd>
      </div>
      {activity && (
        <>
          <div>
            <dt>モデル呼び出し</dt>
            <dd>
              {count(activity.models.reduce((sum, row) => sum + row.calls, 0))}
            </dd>
          </div>
          <div>
            <dt>ツール呼び出し</dt>
            <dd>
              {count(activity.tools.reduce((sum, row) => sum + row.calls, 0))}
            </dd>
          </div>
        </>
      )}
      <div>
        <dt>参考費用（USD）</dt>
        <dd>{cost(usage.cost)}</dd>
      </div>
    </dl>
  );
}

function UsageBreakdown({
  usage,
  activity,
}: {
  usage: ConversationUsage;
  activity?: RecordedUsage;
}) {
  const totals =
    activity &&
    [...activity.models, ...activity.tools].reduce(
      (sum, row) => ({
        calls: sum.calls + row.calls,
        errors: sum.errors + row.errors,
      }),
      { calls: 0, errors: 0 },
    );
  return (
    <div
      className="table-card table-responsive mb-0"
      tabIndex={0}
      aria-label="使用量の内訳"
    >
      <table className="table table-sm table-striped usage-table mb-0">
        <caption className="visually-hidden">
          回数・トークン・費用の内訳
        </caption>
        <thead className="table-active">
          <tr>
            <th scope="col">モデル / ツール</th>
            <th scope="col">回数</th>
            <th scope="col">エラー</th>
            <th scope="col">入力</th>
            <th scope="col">出力</th>
            <th scope="col">キャッシュ読込</th>
            <th scope="col">キャッシュ書込</th>
            <th scope="col">合計トークン</th>
            <th scope="col">参考費用（USD）</th>
          </tr>
        </thead>
        <tbody>
          <UsageRows usage={usage.models} activity={activity?.models} />
          <UsageRows usage={usage.tools} activity={activity?.tools} tool />
        </tbody>
        <tfoot className="table-active fw-semibold">
          <UsageRow
            name="合計"
            usage={usage.total}
            calls={totals?.calls}
            errors={totals?.errors}
          />
        </tfoot>
      </table>
    </div>
  );
}

function useRecordedUsage(path: string, latestEntry?: number) {
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{
    path: string;
    activity?: RecordedUsage;
    error?: string;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    void api<RecordedUsage>(path, "GET", undefined, controller.signal).then(
      (activity) => {
        if (!controller.signal.aborted) setResult({ path, activity });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            path,
            error:
              error instanceof Error
                ? error.message
                : "統計を読み込めませんでした",
          });
      },
    );
    return () => controller.abort();
  }, [path, latestEntry, reload]);
  const current = result?.path === path ? result : undefined;
  return {
    activity: current?.activity,
    status: current?.error ? (
      <div className="d-flex align-items-center gap-2 mb-3" role="alert">
        <span>{current.error}</span>
        <button
          className="btn-outline theme-secondary btn-sm"
          onClick={() => setReload((n) => n + 1)}
        >
          再試行
        </button>
      </div>
    ) : current ? null : (
      <p className="small fg-2 mb-3" role="status">
        集計中…
      </p>
    ),
    reload: () => setReload((n) => n + 1),
  };
}

export function SessionUsage({
  id,
  usage,
  latestEntry,
}: {
  id: string;
  usage: ConversationUsage;
  latestEntry?: number;
}) {
  const { activity, status } = useRecordedUsage(
    `/api/conversations/${id}/usage`,
    latestEntry,
  );
  return (
    <section className="session-usage" aria-label="使用量">
      {status}
      <UsageSummary usage={usage.total} activity={activity} />
      <UsageBreakdown usage={usage} activity={activity} />
    </section>
  );
}

function DailyUsage({
  days,
  calls = false,
}: {
  days: RecordedUsage["days"];
  calls?: boolean;
}) {
  const name = calls ? "日別の呼び出し件数" : "日別の使用量";
  return (
    <div
      className={calls ? "table-card table-responsive mb-0" : "table-card mb-0"}
      tabIndex={calls ? 0 : undefined}
      aria-label={calls ? name : undefined}
    >
      <table className="table table-striped usage-table mb-0">
        <caption className="visually-hidden">{name}</caption>
        <thead className="table-active">
          <tr>
            <th scope="col">日付</th>
            {calls ? (
              <>
                <th scope="col">モデル呼び出し</th>
                <th scope="col">ツール呼び出し</th>
                <th scope="col">ツールエラー</th>
              </>
            ) : (
              <th scope="col">合計トークン</th>
            )}
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.date}>
              <th scope="row">{day.date}</th>
              {calls ? (
                <>
                  <td>{count(day.modelCalls)}</td>
                  <td>{count(day.toolCalls)}</td>
                  <td>{count(day.toolErrors)}</td>
                </>
              ) : (
                <td>{numbers.format(day.totalTokens)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsagePeriod() {
  const [{ from, to, timezone }] = useState(() => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const to = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone }).format(
      new Date(),
    );
    const start = new Date(`${to}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 29);
    return { from: start.toISOString().slice(0, 10), to, timezone };
  });
  const [start, setStart] = useState(from);
  const [end, setEnd] = useState(to);
  const [period, setPeriod] = useState({ from, to, timezone });
  const { activity, status, reload } = useRecordedUsage(
    `/api/statistics/usage?${new URLSearchParams(period)}`,
  );
  return (
    <>
      <form
        className="usage-period d-flex flex-wrap align-items-end gap-2 my-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (period.from === start && period.to === end) reload();
          else setPeriod({ from: start, to: end, timezone });
        }}
      >
        <label>
          開始日
          <input
            className="form-control form-control-sm mt-1"
            type="date"
            required
            max={end || "9999-12-31"}
            value={start}
            onChange={(event) => setStart(event.target.value)}
          />
        </label>
        <label>
          終了日
          <input
            className="form-control form-control-sm mt-1"
            type="date"
            required
            min={start || undefined}
            max="9999-12-31"
            value={end}
            onChange={(event) => setEnd(event.target.value)}
          />
        </label>
        <button className="btn-solid theme-primary btn-sm" type="submit">
          集計
        </button>
      </form>
      {status}
      {activity &&
        (activity.days.length ? (
          <>
            <UsageSummary usage={activity.total} />
            <details className="usage-details mb-4">
              <summary className="py-2 fw-semibold">詳しい内訳</summary>
              <div className="pt-2">
                <UsageBreakdown usage={activity} activity={activity} />
                <h3 className="h6 mt-4">日別の呼び出し件数</h3>
                <DailyUsage days={activity.days} calls />
              </div>
            </details>
            <h3 className="h6 mb-2">日別の使用量</h3>
            <DailyUsage days={activity.days} />
          </>
        ) : (
          <p role="status">この期間の使用記録はありません</p>
        ))}
    </>
  );
}

export function UsageStatistics() {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="sidebar-statistics btn-text theme-secondary btn-sm"
        aria-label="全セッションの統計"
        title="全セッションの統計"
        aria-haspopup="dialog"
        onClick={() => {
          dialog.current?.showModal();
          setOpen(true);
        }}
      >
        <Icon name="usage" />
        <span className="sidebar-label-text">使用量の統計</span>
      </button>
      {createPortal(
        <dialog
          ref={dialog}
          className="session-dialog usage-dialog"
          aria-labelledby={heading}
          onClose={() => setOpen(false)}
        >
          <header className="d-flex justify-content-between align-items-center gap-3">
            <h2 id={heading}>全セッションの統計</h2>
            <button
              autoFocus
              className="btn-text theme-secondary btn-sm icon-button"
              type="button"
              aria-label="統計を閉じる"
              onClick={() => dialog.current?.close()}
            >
              <Icon name="close" />
            </button>
          </header>
          {open && <UsagePeriod />}
        </dialog>,
        document.body,
      )}
    </>
  );
}
