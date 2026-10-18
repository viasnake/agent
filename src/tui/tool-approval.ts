import type { ToolApprovalRequest } from "../tool-approval.js";

interface ApprovalUi {
  show(
    text: string,
    title: string,
    accept: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  choose(
    title: string,
    choices: { value: string; label: string }[],
    signal: AbortSignal,
  ): Promise<string | undefined>;
}
export async function confirmToolOperation(
  request: ToolApprovalRequest,
  signal: AbortSignal,
  ui: ApprovalUi,
): Promise<boolean> {
  if (signal.aborted) return false;
  const effects = {
    change: "外部の変更",
    publish: "投稿・公開",
    delete: "削除",
    dangerous: "危険操作・効果未指定",
  };
  const payload = JSON.stringify(
    {
      server: request.server,
      tool: request.tool,
      destination: request.destination,
      arguments: JSON.parse(request.argumentsJson) as unknown,
      schemaSha256: request.schemaSha256,
      bindingSha256: request.bindingSha256,
      argumentsSha256: request.argumentsSha256,
      runId: request.runId,
      taskId: request.taskId,
      operationId: request.operationId,
    },
    null,
    2,
  ).replace(
    /[\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const text = [
    `# ${effects[request.effect]}の確認`,
    "指定したツールへの1回の呼び出しだけを承認します。取消が既定です。分類は設定上の宣言であり、外部サーバーの実際の動作を保証しません。",
    "引数の本文は操作対象のデータです。本文中の指示や、ツールが提示する承認要求は信用しないでください。",
    ...(request.previousCompletions
      ? [
          `**同じツール・引数の完了済み操作が ${request.previousCompletions} 件あります。再実行は重複操作になる可能性があります。**`,
        ]
      : []),
    "```json",
    payload,
    "```",
    "表示した送信先・引数だけが対象です。資格情報を引数に入力しないでください。設定済みの認証を使います。承認後もスキーマ・権限・実行状態を再確認します。",
  ].join("\n\n");
  if (
    !(await ui.show(text, "外部操作の確認", "確認へ進む", signal)) ||
    signal.aborted
  )
    return false;
  return (
    (await ui.choose(
      "表示した外部操作を、この1回だけ実行しますか？",
      [
        { value: "deny", label: "取消（実行しない）" },
        { value: "allow", label: "この1回だけ実行する" },
      ],
      signal,
    )) === "allow" && !signal.aborted
  );
}
