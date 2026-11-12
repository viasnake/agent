import type { ConversationUsage, UsageTotals } from "../src/usage.js";

const tokens = new Intl.NumberFormat("ja-JP");
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 6,
  maximumFractionDigits: 6,
});

function cost(value: number | null) {
  return value === null ? "N/A" : dollars.format(value);
}

function UsageRow({ name, usage }: { name: string; usage: UsageTotals }) {
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>{tokens.format(usage.input)}</td>
      <td>{tokens.format(usage.output)}</td>
      <td>{tokens.format(usage.cacheRead)}</td>
      <td>{tokens.format(usage.cacheWrite)}</td>
      <td>{tokens.format(usage.totalTokens)}</td>
      <td>{cost(usage.cost)}</td>
    </tr>
  );
}

export function SessionUsage({ usage }: { usage: ConversationUsage }) {
  return (
    <section className="session-usage" aria-label="使用量">
      <dl className="usage-summary">
        <div>
          <dt>合計トークン</dt>
          <dd>{tokens.format(usage.total.totalTokens)}</dd>
        </div>
        <div>
          <dt>参考費用（USD）</dt>
          <dd>{cost(usage.total.cost)}</dd>
        </div>
      </dl>
      <div className="table-responsive" tabIndex={0} aria-label="使用量の内訳">
        <table className="table usage-table">
          <caption className="visually-hidden">トークン・費用の内訳</caption>
          <thead>
            <tr>
              <th scope="col">モデル / ツール</th>
              <th scope="col">入力</th>
              <th scope="col">出力</th>
              <th scope="col">キャッシュ読込</th>
              <th scope="col">キャッシュ書込</th>
              <th scope="col">合計トークン</th>
              <th scope="col">参考費用（USD）</th>
            </tr>
          </thead>
          <tbody>
            {usage.models.map((row) => (
              <UsageRow key={`model:${row.name}`} name={row.name} usage={row} />
            ))}
            {usage.tools.map((row) => (
              <UsageRow
                key={`tool:${row.name}`}
                name={`ツール: ${row.name}`}
                usage={row}
              />
            ))}
          </tbody>
          <tfoot>
            <UsageRow name="合計" usage={usage.total} />
          </tfoot>
        </table>
      </div>
      <p className="small fg-2">
        N/A：費用不明。実際の請求額・利用枠は契約先で確認してください。
      </p>
    </section>
  );
}
