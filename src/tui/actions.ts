import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { AgentError } from "../types.js";

export function commandPath(argument: string): string {
  let path = argument.trim();
  if (path.startsWith('"') || path.startsWith("'")) {
    if (path.length < 2 || path.at(-1) !== path[0])
      throw new AgentError("INPUT_PATH", "パスを囲む引用符を閉じてください。");
    path = path.slice(1, -1);
  }
  if (!path)
    throw new AgentError("INPUT_PATH", "画像の相対パスを指定してください。");
  return path;
}
export const actions = {
  palette: {
    keys: ["ctrl+p"],
    description: "操作を検索して選ぶ",
    command: "/commands",
  },
  model: {
    keys: ["ctrl+l"],
    description: "モデル・担当を選択",
    command: "/model",
  },
  tools: {
    keys: ["ctrl+o"],
    description: "ツール結果を開閉",
    command: "/tools",
  },
  next: {
    keys: ["alt+enter"],
    description: "完了後の依頼に追加",
    command: "/next",
  },
  cancel: {
    keys: ["escape"],
    description: "画面を閉じる／中断",
    command: "/stop",
  },
  interrupt: {
    keys: ["ctrl+c"],
    description: "入力を下書き保存／中断／保存して終了",
    command: "/quit",
  },
  eof: {
    keys: ["ctrl+d"],
    description: "空入力で保存して終了（入力中は文字削除）",
    command: "/quit",
  },
  up: {
    keys: ["pageUp"],
    description: "会話を上へスクロール",
    command: "/history",
  },
  down: {
    keys: ["pageDown"],
    description: "会話を下へスクロール",
    command: "/history",
  },
} satisfies Record<
  string,
  { keys: KeyId[]; description: string; command: string }
>;
export type ActionName = keyof typeof actions;
export type KeyOverrides = Partial<Record<ActionName, KeyId[]>>;
export function actionFor(
  data: string,
  overrides: KeyOverrides = {},
): ActionName | undefined {
  return (Object.keys(actions) as ActionName[]).find((key) =>
    (overrides[key] ?? actions[key].keys).some((k) => matchesKey(data, k)),
  );
}
export const commands = [
  ["commands", "操作を検索"],
  ["new", "新しい会話"],
  ["resume", "待機・クラッシュした作業を明示再開"],
  ["sessions", "会話を選択・再開"],
  ["search", "会話・依頼・イベント・資料・作業ファイルをローカル検索"],
  ["fork", "過去の時点から新しい会話へ分岐（実行・適用なし）"],
  ["backup", "全会話・出典・成果物の非公開バックアップ（実行環境は対象外）"],
  [
    "prune-pins",
    "終了済みプロセスの添付保護記録を確認・整理（添付本体は保持）",
  ],
  [
    "backup-open",
    "バックアップの会話・資料を読取専用で閲覧・選択書出（取込・実行なし）",
  ],
  ["diagnostics", "本文・パス・認証情報なしの限定診断を確認・保存（通信なし）"],
  ["delete", "この作業場所の会話・実行を選択削除（候補確認・明示確定）"],
  ["prune", "保持期間を過ぎた履歴の削除候補・保持理由を確認"],
  ["cleanup-deletions", "全作業場所のファイル削除保留ジョブを確認・明示再試行"],
  ["cache-cleanup", "共有画像・文書・checkpoint の削除候補を確認・明示削除"],
  ["continue", "前回の会話・下書きを開く"],
  ["rename", "会話名を変更"],
  ["model", "次の依頼のモデルと担当構成"],
  ["model-change", "待機中の担当モデルを明示切替（再開なし）"],
  ["tasks", "担当・状態・検査"],
  ["status", "接続・利用量・状態の詳細"],
  ["diff", "変更と差分"],
  ["apply", "確認して適用"],
  ["artifacts", "文書・出典・検査結果"],
  ["sources", "資料本文・行番号の確認／同じ原資料を送信から除外"],
  ["versions", "文書の版・差分・来歴・検査を確認"],
  ["research", "調査メモ・検索履歴・検索設定を確認"],
  ["images", "画像を送信前に追加・編集・除外"],
  ["clipboard", "クリップボード画像をローカル保存"],
  ["git", "ブランチ・状態・最近のコミットを参照"],
  ["editor", "外部エディタで下書き・成果物の改訂案を編集"],
  ["editor-config", "外部エディタの起動引数を設定"],
  ["keys", "キー割当を表示・変更"],
  ["settings", "接続・権限・上限"],
  ["login", "認証"],
  ["doctor", "ローカル診断"],
  ["probe", "モデルを呼び出して疎通試験"],
  ["compact", "コンテキストの引き継ぎ"],
  ["pins", "ユーザー固定メモの表示・編集"],
  ["context", "会話コンテキストと原文の表示"],
  ["help", "操作一覧"],
  ["queue", "待機入力の編集・取消・実行"],
  ["next", "完了後の依頼を入力"],
  ["stop", "現在の作業を中断"],
  ["quit", "終了"],
  ["history", "会話履歴"],
  ["expand", "長文を会話内で展開"],
  ["tools", "ツール結果"],
  ["reconcile", "未確定操作の照合"],
  ["kind", "自動判定・依頼の種類"],
  ["access", "次の送信1回のみアクセス権を上書き"],
].map(([name, description]) => ({ name: name!, description: description! }));
