# 単独・協調モデルの比較

`eval-compare` は、同じケース・入力・検査・実行ごとの予算を single / reviewed / assisted で実行します。ケースと構成は分離し、順番を試行ごとに循環させます。各試行は新しい作業コピーとモデル会話を使い、元のプロジェクトに差分を適用しません。

```sh
agent eval-compare --suite examples/comparison.yaml
agent eval-compare --suite examples/comparison.yaml --confirm-run
agent eval-report <comparison-id>
agent eval-report <comparison-id> --summary-only
```

既定は確認表示のみで、推論を開始しません。`--confirm-run` は全試行の推論を許可するため、表示された試行数・送信先の設定・予算を先に確認してください。実モデルの接続と資格情報は通常の設定を使います。入力や workspace の相対パスは suite ファイル基準です。サンプルは架空の日本語案内文で、研究成果や実モデルの品質測定結果ではありません。

各試行を完了するたびに、非公開の state/comparisons ディレクトリへ保存します。中断時も完了済み試行を読めます。設定や入力のハッシュが変わった場合は、変更後の条件でモデルを呼び出しません。入力変更を検出したケースは以前の試行も比較対象から外し、失敗記録自体は残します。中断された比較を自動再実行しません。

## 指標の読み方

- `attempted` / `expected`: 実行を試みた数と計画数。準備失敗も隠しません。
- `setupFailed` / `failed` / `attemptSuccessRate`: 準備失敗、実行失敗、全試行中の成功状態の割合です。
- `comparable` / `checksPassRate`: 入力・設定が一致した比較対象と、その中で実際の機械検証を通過した割合です。成功状態だけでなく保存された検査結果を読みます。意味的な品質の点数ではありません。
- `humanAcceptanceRate` / `majorDefects` / `reworkCount`: 根拠付き人手評価を登録した比較対象だけを集計します。未評価は `null` で、0点や合格にはしません。
- `meanElapsedMs`: 準備・推論・検証を含む、失敗を除外しない全試行の平均時間です。早い準備失敗を性能向上と解釈しないでください。
- トークン数と費用の未報告値は `null` です。`knownCostUsd` は判明分のみ、`totalCostUsd` は全リクエストの費用が確定した場合だけ数値になります。`heldUsd` は保留中の予約額で、確定費用ではありません。

リクエスト数・トークン・レビュー・再作業の負荷は同じ実行予算へ計上されます。呼び出し順は循環であり無作為ではありません。プロバイダー負荷、キャッシュ、レート制限、モデルの非決定性は統制されないため、この結果だけで統計的優位や「協調のほうが高品質」と断定しないでください。

## 人手評価

完了した比較の run ID と、次の JSON/YAML を指定します。成果物と元の条件を実際に読み、欠陥の場所や理由を evidence に残してください。自動検査の成功だけから採用可否を生成しないでください。

```yaml
reviewer: reviewer-name
accepted: false
majorDefects: 1
reworkCount: 1
evidence: "answer.md の第2段落が指定された対象読者を取り違えている。修正を1回依頼。"
```

```sh
agent eval-assess <comparison-id> <run-id> --assessment assessment.yaml --confirm
```

評価を更新しても以前の評価は監査ログに残ります。途中の比較は閲覧のみです。レポートには依頼文・入力パス・成果物ID・評価理由が含まれるため、外部共有前に内容を確認してください。認証情報や生のプロバイダー応答を評価ファイルに記録しないでください。
