import type { Config } from "../config.js";
import type { Conversation } from "../conversations.js";
import type { Application } from "../application.js";
import { safeText } from "./components.js";

type Context = Pick<Conversation, "model" | "localOnly" | "dataClass">;

export function connectionProblems(config: Config, context: Context): string[] {
  const models = context.model
    ? Object.entries(config.models).filter(([name]) => name === context.model)
    : Object.entries(config.models);
  if (!models.length)
    return [
      context.model
        ? `モデル ${context.model} は未登録です。`
        : "モデルが未登録です。",
    ];
  const problems = models.map(([, model]) => {
    const name = model.connection,
      connection = config.connections[name];
    if (!connection) return `接続 ${name} は未登録です。`;
    if (!connection.enabled)
      return `接続 ${name} は無効です。/settings → 登録済みの接続 → ${name} → enabled を確認してください。`;
    if (
      (context.localOnly || context.dataClass === "restricted") &&
      connection.type !== "local"
    )
      return `接続 ${name} はローカル専用の条件に合いません。ローカルモデルを選んでください。`;
    if (!connection.allowedData.includes(context.dataClass))
      return `接続 ${name} は ${context.dataClass} の送信を許可していません。許可済みの接続を選ぶか、送信範囲を /settings で確認してください。`;
    if (
      connection.billing === "api" &&
      (!config.limits.maxApiUsd || !connection.maxRequestUsd)
    )
      return `接続 ${name} の API 予算が未設定です。limits.maxApiUsd と maxRequestUsd を /settings で確認してください。`;
    if (
      !["local", "chatgpt"].includes(connection.type) &&
      (!connection.secretEnv || !process.env[connection.secretEnv])
    )
      return `接続 ${name} の認証情報がありません。${connection.secretEnv ?? "secretEnv に指定する環境変数"} を起動環境に設定してください。`;
    return "";
  });
  // An automatic selection may still use another configured connection.
  return problems.includes("") ? [] : [...new Set(problems)];
}

export function setupSummary(config: Config, context: Context): string[] {
  const problems = connectionProblems(config, context);
  return problems.length
    ? [
        "接続の準備が必要です",
        "1  /settings で接続・モデルを登録",
        "2  送信区分・予算を確認して接続を有効化",
        "3  /probe で疎通を確認（利用枠を消費）",
      ]
    : [
        "接続設定あり · 疎通は /probe で確認",
        "コード変更の前に /settings で必須検査、/doctor で隔離環境を確認。",
      ];
}

export function failureGuidance(
  reason: string,
  config: Config,
  context: Context,
): string {
  if (reason.startsWith("NO_MODEL")) {
    const problems = connectionProblems(config, context);
    return [
      "利用できるモデルが見つかりません。",
      ...problems,
      ...(problems.length
        ? []
        : [
            "/model で担当モデルを、/settings で用途・担当・tools・認証・予算を確認してください。",
          ]),
      "設定を直した後、新しい依頼として送信してください。",
      "診断コード: NO_MODEL",
    ].join("\n");
  }
  if (reason.startsWith("SANDBOX") || reason.startsWith("CHECK_CONFIG"))
    return `${reason}\n/doctor で隔離環境、/settings で必須検査を確認してください。`;
  return reason;
}

export function doctorSummary(
  report: Awaited<ReturnType<Application["doctor"]>>,
): string {
  return [
    "# ローカル診断",
    "モデルは呼び出していません。認証・推論の疎通確認は /probe（利用枠を消費）。",
    "## 実行環境",
    `Node ${report.node} · ${report.platform}`,
    `隔離環境: ${report.sandbox.ok ? "利用可能" : "要対応"}`,
    safeText(report.sandbox.detail),
    ...(!report.sandbox.ok
      ? [
          "Bubblewrap または rootless Podman を準備し、/settings → 詳細設定 → execution を確認してください。",
        ]
      : []),
    "## 接続",
    ...(report.connections.length
      ? report.connections.flatMap((c) => [
          `### ${safeText(c.name)} · ${c.enabled ? "有効" : "無効"}`,
          `${c.type} · 送信許可: ${c.allowedData.join(", ")}`,
          `認証: ${c.type === "local" ? "ローカル接続（認証の疎通は未確認）" : c.credential === "present" ? "起動環境に設定あり（疎通は未確認）" : c.credential.startsWith("missing:") ? `未設定 (${safeText(c.credential.slice(8))})` : c.credential}`,
          `予算: ${c.budget === false ? "要設定" : c.budget === true ? "設定あり" : "従量 API 対象外"}`,
        ])
      : ["接続がありません。/settings → 接続を追加 から登録してください。"]),
    "",
    "接続の変更: /settings → 登録済みの接続",
    "## 隔離の方針",
    report.isolation,
  ].join("\n\n");
}
