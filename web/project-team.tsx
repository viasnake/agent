import type { ProjectRow } from "../src/projects.js";
import { Icon } from "./icons.js";

export const projectRoles = {
  lead: { name: "主担当", task: "作業を分担し、報告をまとめて納品します。" },
  reviewer: {
    name: "レビュアー",
    task: "成果物を依頼と証拠に照らし、納品または差し戻しを判定します。",
  },
};
const memberLabels = {
  queued: "待機中",
  running: "作業中",
  reported: "報告済み",
  failed: "実行失敗",
  interrupted: "中断",
};
export function ProjectTeamStatus({
  project: p,
  showSummary = true,
  includeLead = false,
}: {
  project: ProjectRow;
  showSummary?: boolean;
  includeLead?: boolean;
}) {
  const hasReview = !!(p.evidence || p.assessment);
  if (
    !includeLead &&
    !p.members.length &&
    !hasReview &&
    !(showSummary && p.summary)
  )
    return null;
  return (
    <details className="project-team-detail">
      <summary>
        <span>
          {includeLead
            ? "担当とモデル"
            : p.members.length
              ? `分担 ${p.members.length} 件`
              : hasReview
                ? "検証記録"
                : "進捗"}
        </span>
        {p.members.length > 0 && (
          <span className="team-names">
            {p.members.map((member) => member.role).join("・")}
          </span>
        )}
        <Icon name="chevron" />
      </summary>
      {includeLead && (
        <dl className="team-roles">
          {Object.entries(projectRoles).map(([role, { name, task }]) => (
            <div key={name}>
              <dt>{name}</dt>
              {p.models && (
                <dd className="post-model">
                  {role === "lead" ? p.models.lead : p.models.reviewer}
                </dd>
              )}
              <dd>{task}</dd>
            </div>
          ))}
        </dl>
      )}
      {p.assessment && (
        <p>
          <strong>納品判定 </strong>
          {p.assessment.verdict === "checking"
            ? "確認中"
            : p.assessment.verdict === "revise"
              ? "要修正"
              : p.assessment.verdict === "unavailable"
                ? "検証中断"
                : "確認済み"}
          {p.assessment.reason && " · " + p.assessment.reason}
        </p>
      )}
      {p.assessment &&
        "sources" in p.assessment &&
        p.assessment.sources?.map(({ label, quote }) => (
          <blockquote className="work-source" key={quote}>
            <strong>{label}</strong>
            {quote}
          </blockquote>
        ))}
      {showSummary && p.summary && <p>{p.summary}</p>}
      {p.evidence && (
        <p>
          <strong>根拠 </strong>
          {p.evidence}
        </p>
      )}
      <ul>
        {p.members.map((m) => (
          <li key={m.id}>
            <b>{m.role}</b> · {memberLabels[m.status]}{" "}
            {m.model && <span className="post-model">{m.model}</span>}
            <div>{m.task}</div>
            {m.status === "running" && <div>{m.activity}</div>}
            {m.report && <p>{m.report}</p>}
            {m.check && (
              <details>
                <summary>テスト{m.check.passed ? "成功" : "失敗"}</summary>
                <pre>
                  {m.check.command && "$ " + m.check.command + "\n"}
                  {m.check.output || "出力なし"}
                </pre>
              </details>
            )}
            {m.file && (
              <a
                href={`/api/conversations/${p.id}/download?path=${encodeURIComponent(m.file)}`}
              >
                パッチを保存
              </a>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
