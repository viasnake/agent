import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
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
export function actionFor(data: string): keyof typeof actions | undefined {
  return (Object.keys(actions) as Array<keyof typeof actions>).find((key) =>
    actions[key].keys.some((k) => matchesKey(data, k)),
  );
}
export const commands = [
  ["commands", "操作を検索"],
  ["new", "新しい会話"],
  ["resume", "待機・クラッシュした作業を明示再開"],
  ["sessions", "会話を選択・再開"],
  ["continue", "前回の会話・下書きを開く"],
  ["rename", "会話名を変更"],
  ["model", "モデルと担当構成"],
  ["tasks", "担当・状態・検査"],
  ["status", "接続・利用量・状態の詳細"],
  ["diff", "変更と差分"],
  ["apply", "確認して適用"],
  ["artifacts", "文書・出典・検査結果"],
  ["images", "保存済み画像・参照ID・原本の場所"],
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
