# Firecracker-first: PR 1 の判断記録

## 採用範囲

最初の正式な VM バックエンドは Firecracker。通常 VM + SSH の先行実装はしない。
PR 1 は実ゲストの cold boot、永続ディスク、Guest Runner の readiness、コマンド実行、停止・再起動・破棄を対象とする。
Snapshot、ファイルツール統合、会話との紐付け、PTY、外部ネットワーク許可、独立検証 VM は後続 PR。

既存 `execution.backend` に Firecracker を追加して Shell だけを差し替えると、
`TaskTools` のホストファイル操作とゲストの Shell が別の作業領域を参照する。
この危険な中間状態を公開しない。PR 1 は独立した `agent environment` CLI と
`ExecutionEnvironment` 契約を提供し、PR 2 で全ツールを一緒に切り替える。
既存 TUI、Pi SDK、Harness、SQLite、権限・予算・適用の仕組みは置き換えない。

## 通信: vsock を採用

SSH は成熟した転送・PTY 機能を持つが、管理用 NIC/TAP、ネットワーク制御、ゲストごとの
ホスト鍵配布を最初から必要とする。vsock は Firecracker の環境ごとの Unix socket から
Guest Runner へ接続でき、ゲスト NIC を一切公開せずに開始できるため初期実装に採用する。
SSH は同時実装しない。通信は環境別の秘密値による認証と識別、サイズ上限、期限を持つ。
vsock も無条件に信頼するチャネルではなく、ゲストの応答は未信頼入力として扱う。

## 権限分離

Agent/TUI は非 root。管理者が内容を確認して配置する限定的なホストヘルパーだけが
jailer、namespace、cgroup、管理ディスクを操作する。一般ユーザーから任意のパス、
実行バイナリ、kernel、rootfs、jailer 引数を特権経路へ渡せないようにする。
管理設定・イメージは root 所有で固定ハッシュを検証する。環境の所有者を認可し、
VMM は制御ユーザーとは異なる UID に降格する。API/vsock socket と認証・会話・元 Git
リポジトリをゲストへ共有しない。ゲスト起点のホスト宛 vsock サービスも公開しない。

NIC/TAP を付けない初期構成では、依存取得も公開 Web アクセスもできない。
専用 network namespace とホスト側 cgroup・固定長ディスク・同時実行・時間・通信量制限を使う。
起動・接続・実行の不明な結果を成功とみなさず、別バックエンドにもフォールバックしない。
セットアップは明示的な管理者操作であり、KVM/Proxmox の特権設定を自動修復しない。

## 現在の実行経路の分類

| 現在の場所                       | 制御ホストに残す処理                                                    | ゲストへ移す処理 / 境界                                                             |
| -------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/tools.ts`                   | 権限、予算、operation journal、ツール引数検査                           | list/read/search/write/edit/delete と Shell はすべて同一 workspace。PR 2 で一括統合 |
| `src/workspace.ts`               | 元 Git の HEAD/状態取得、安全な初期コピー、適用競合判定                 | 開発用 inventory/diff の入力取得は環境 API 経由。元 `.git` や認証情報を共有しない   |
| `src/sandbox/`, `src/sandbox.ts` | 従来の明示的 Bubblewrap/Podman バックエンド                             | 新規 VM は別の ExecutionEnvironment。既存 Sandbox の黙示的分岐に混ぜない            |
| `src/mcp.ts`                     | schema pinning、認可、リモート接続の認証情報                            | stdio MCP の実行・実体ハッシュ検証はゲスト側。ホスト MCP への抜け道は作らない       |
| `src/validation.ts`              | 検査ポリシー、保護対象、成功判定と Manifest 固定                        | 実行検査は編集環境から独立した microVM。PR 5                                        |
| `src/artifacts.ts`               | ハッシュ再検証、確認と journal 付き `/diff`・`/apply`、元 repo との照合 | バイナリを含む成果物を制限付き転送。ゲストのディスクをホストで mount/extract しない |
| `src/application.ts`             | 会話選択・キュー・世代・キャンセル・UI                                  | 環境 ID との紐付け・再接続は PR 3。モデル Runtime と環境を独立させる                |
| `src/storage.ts`                 | SQLite、会話の正本、認証、予算、lease、操作記録・成果物                 | ゲストに DB や Agent home を公開しない                                              |

## 参照

- [Firecracker v1.16.2 jailer](https://github.com/firecracker-microvm/firecracker/blob/v1.16.2/docs/jailer.md)
- [Firecracker v1.16.2 vsock](https://github.com/firecracker-microvm/firecracker/blob/v1.16.2/docs/vsock.md)
- [Firecracker v1.16.2 getting started](https://github.com/firecracker-microvm/firecracker/blob/v1.16.2/docs/getting-started.md)

実行バイナリと jailer は公式リリース v1.16.2 に固定する。初期の互換性
fixture は Firecracker CI の v1.12 `vmlinux-6.1.128` と `ubuntu-24.04.squashfs`
を使う（v1.16 の同じ S3 fixture は公開されていないため）。これは本番向けの
硬化済みイメージの主張ではなく、管理者が更新・検証してから明示的にセットアップ
するための入力である。変換後 ext4 のダイジェストは管理設定へ記録し、更新時に
再検査する。

単体試験の成功は実 KVM の成功を意味しない。実機試験の有無とその環境条件は PR ごとに記録する。
