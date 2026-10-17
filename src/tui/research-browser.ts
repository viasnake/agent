import type { Application } from "../application.js";
import {
  AgentError,
  type Artifact,
  type ArtifactHistoryEntry,
  type ArtifactProvenance,
  type ResearchCheckpoint,
} from "../types.js";
import { runLabels } from "./workbench.js";

interface Dialogs {
  choose(
    title: string,
    choices: { value: string; label: string; description?: string }[],
  ): Promise<string | undefined>;
  show(text: string, title?: string): Promise<boolean>;
  confirm(text: string): Promise<boolean>;
  notice(text: string): void;
}

function literal(text: string, language = ""): string {
  let length = 3;
  for (const match of text.matchAll(/`+/g))
    length = Math.max(length, match[0].length + 1);
  const fence = "`".repeat(length);
  return `${fence}${language}\n${text}\n${fence}`;
}

export function provenanceText(provenance: ArtifactProvenance): string {
  const identity = `文書 ID: ${provenance.artifactId}\nSHA-256: ${provenance.artifactSha256}`;
  if (provenance.status === "unknown")
    return `${identity}\n\n旧形式・来歴不明。検査や引用の証明はありません。`;
  return [
    identity,
    `生成した作業: ${provenance.producingRunId}`,
    `親作業: ${provenance.parentRunId ?? "なし"}`,
    "\n## 利用可能だった資料（実際に引用した証明ではありません）",
    literal(provenance.availableInputSourceIds.join("\n") || "なし"),
    "## 文書に記載された引用（正しさは検査結果と原文で確認）",
    literal(
      provenance.citedSourceRanges
        .map(
          (range) =>
            range.rawCitation ??
            `${range.sourceId}:L${range.startLine}-L${range.endLine}`,
        )
        .join("\n") || "なし",
    ),
    ...(provenance.unavailableCitedSourceIds.length
      ? [
          "## 生成時に利用可能な資料として確認できない引用 ID",
          literal(provenance.unavailableCitedSourceIds.join("\n")),
          "この ID の記載は資料へのアクセス許可や引用の裏付けではありません。",
        ]
      : []),
    "## 保存された検査",
    `検査 ID: ${provenance.validation.artifactId}`,
    `検査 SHA-256: ${provenance.validation.sha256}`,
    ...provenance.validation.checks.map(
      (check) =>
        `${check.passed ? "PASS" : "FAIL"} · ${check.id}\n${literal(check.detail)}`,
    ),
    "検査の存在・成功だけで、内容の意味や事実の正しさを証明するものではありません。",
  ].join("\n\n");
}

export function checkpointText(checkpoint?: ResearchCheckpoint): string {
  if (!checkpoint) return "保存済みの調査メモはありません。";
  return [
    "モデル作成の未検証メモです。ユーザーの固定メモ・指示・権限とは別に保存されています。",
    `保存日時: ${new Date(checkpoint.updatedAt).toISOString()}`,
    "## 要約",
    literal(checkpoint.summary),
    "## 調べた範囲",
    literal(checkpoint.searchedScopes.join("\n") || "未記載"),
    "## 未解決の質問",
    literal(checkpoint.openQuestions.join("\n") || "未記載"),
    "## 判断と参照資料",
    ...checkpoint.decisions.map(
      (decision) =>
        `${literal(decision.text)}\n資料: ${decision.sourceIds.join(", ") || "参照なし"}`,
    ),
    ...(checkpoint.unavailableSourceIds?.length
      ? [
          "## 除外などで利用できなくなった資料",
          literal(checkpoint.unavailableSourceIds.join("\n")),
          "過去の要約や判断の記述が消去されたわけではありません。",
        ]
      : []),
    "この画面を開いても再検索・再取得はしません。",
  ].join("\n\n");
}

export class ResearchBrowser {
  constructor(
    readonly app: Application,
    readonly dialogs: Dialogs,
  ) {}

  private idle(): void {
    if (this.app.busy)
      throw new AgentError("BUSY", "作業が停止・完了してから開いてください。");
  }

  async research(): Promise<void> {
    this.idle();
    const selection = await this.dialogs.choose("調査の保存済み情報", [
      { value: "checkpoint", label: "調査メモ・未解決の質問" },
      { value: "sources", label: "資料を読む・今後の送信から除外" },
      {
        value: "searches",
        label: "検索履歴（発見用・引用の根拠ではありません）",
      },
      { value: "policy", label: "検索・取得の設定を確認（通信しません）" },
    ]);
    if (selection === "checkpoint")
      await this.dialogs.show(
        checkpointText(this.app.session.context?.researchCheckpoint),
        "調査メモ · モデル作成・未検証",
      );
    else if (selection === "sources") await this.sources();
    else if (selection === "searches") {
      const selected = await this.selectArtifact(
        (artifact) =>
          artifact.kind === "report" && artifact.metadata.type === "web-search",
        "保存済み検索 · 発見用",
      );
      if (selected)
        await this.dialogs.show(
          "検索結果はページ本文の証拠ではありません。引用には取得済み資料を使います。\n\n" +
            literal(
              await this.app.artifactText(selected.artifact.id, selected.runId),
              "json",
            ),
          "検索履歴 · 通信なし",
        );
    } else if (selection === "policy") {
      const { web } = this.app.config;
      await this.dialogs.show(
        [
          `検索先: ${web.search?.endpoint ?? "未設定（検索は利用できません）"}`,
          `クエリ引数: ${web.search?.queryParam ?? "未設定"}`,
          `許可ホスト: ${web.allowedHosts.join(", ") || "なし"}`,
          `Web に送信可能な区分: ${web.allowedData.join(", ") || "なし"}`,
          `この会話: ${this.app.session.dataClass}${this.app.session.localOnly ? " / local-only" : ""}`,
          "local-only / restricted では Web 通信できません。検索が未設定でも公開サービスへ自動接続しません。",
          "調査するには通常の入力欄で依頼してください。種類の自動判定を変更する場合は /kind を使います。",
        ].join("\n\n"),
        "検索・取得の設定 · 通信なし",
      );
    }
  }

  async sources(): Promise<void> {
    this.idle();
    const selected = await this.selectArtifact(
      (artifact) => artifact.kind === "source",
      "資料 · 保存済みの抽出本文",
    );
    if (!selected) return;
    const { artifact, runId } = selected;
    const action = await this.dialogs.choose(artifact.name, [
      { value: "read", label: "行番号付き本文・取得情報を読む" },
      { value: "exclude", label: "同じ原資料を今後の送信から除外する" },
    ]);
    if (action === "exclude") await this.excludeSource(artifact.id);
    else if (action === "read") {
      const text = await this.app.artifactText(artifact.id, runId);
      await this.dialogs.show(
        [
          `資料 ID: ${artifact.id}`,
          `SHA-256: ${artifact.sha256}`,
          "保存済みの原文です。除外済みの資料もローカル履歴には残ります。取得日と公開日・更新日は別です。日付メタデータは提供元の申告で、検証済みの事実ではありません。",
          literal(JSON.stringify(artifact.metadata, null, 2), "json"),
          literal(
            text
              .split("\n")
              .map((line, index) => `${index + 1}: ${line}`)
              .join("\n"),
          ),
        ].join("\n\n"),
        "資料本文 · 再取得なし",
      );
    }
  }

  async excludeSource(sourceId: string): Promise<void> {
    this.idle();
    const preview = await this.app.previewSourceExclusion(sourceId);
    const { family } = preview;
    const confirmed = await this.dialogs.confirm(
      [
        "## 今後の送信から資料を除外",
        `選択した資料: ${sourceId}`,
        `対象: 資料・選択範囲 ID ${family.sourceIds.length} 件 / HTTP 原文 ${family.rawArtifactIds.length} 件 / 関連画像 ${family.imageIds.length} 件`,
        "同じ原資料の別ページ・選択範囲も対象です。古いモデルセッションや除外前の作業からは再開せず、新しい依頼で続けてください。",
        "原本・過去の発言・引用・要約・送信済みデータは消去されません。外部サービスからの削除や、言い換えられた記述の除去を保証する操作ではありません。",
        "### 対象 ID",
        literal(
          [
            ...family.sourceIds,
            ...family.rawArtifactIds,
            ...family.imageIds,
          ].join("\n"),
        ),
        "### SHA-256",
        literal(family.hashes.join("\n")),
        "### URL",
        literal(family.urls.join("\n") || "なし"),
      ].join("\n\n"),
    );
    if (!confirmed) return;
    await this.app.excludeSource(sourceId, preview.binding);
    this.dialogs.notice(
      "資料を今後の送信から除外しました。既存の原本・引用・送信済みデータは消去していません。新しい依頼で続けてください。",
    );
  }

  async versions(name?: string): Promise<void> {
    this.idle();
    const selected = await this.selectVersion(
      "文書の版を選択 · 新しい順",
      name,
    );
    if (!selected) return;
    const action = await this.dialogs.choose(selected.artifact.name, [
      { value: "preview", label: "この版を Markdown として読む" },
      { value: "provenance", label: "根拠・引用・実際の検査を確認" },
      { value: "diff", label: "この版を比較前として別の版と比べる" },
    ]);
    if (action === "preview")
      await this.dialogs.show(
        await this.app.artifactText(selected.artifact.id, selected.run.id),
        `文書プレビュー · ${selected.artifact.id}`,
      );
    else if (action === "provenance")
      await this.dialogs.show(
        provenanceText(await this.app.artifactProvenance(selected.artifact.id)),
        "文書の来歴 · 意味の正しさは未証明",
      );
    else if (action === "diff") {
      const after = await this.selectVersion(
        "比較後の版を選択 · 新しい順",
        selected.artifact.name,
        selected.artifact.id,
      );
      if (!after) return;
      const diff = await this.app.artifactDiff(
        selected.artifact.id,
        after.artifact.id,
      );
      await this.dialogs.show(
        `比較前: ${diff.beforeId}\n\n比較後: ${diff.afterId}\n\n${literal(diff.patch, "diff")}`,
        "保存済み文書の差分 · 変更・適用なし",
      );
    }
  }

  private async selectVersion(
    title: string,
    name?: string,
    omit?: string,
  ): Promise<ArtifactHistoryEntry | undefined> {
    let offset = 0;
    while (true) {
      const page = await this.app.artifactHistory(name, offset);
      const visible = page.filter((entry) => entry.artifact.id !== omit);
      if (!visible.length && !offset && page.length < 30) {
        this.dialogs.notice("該当する文書の版はありません。");
        return;
      }
      const selected = await this.dialogs.choose(title, [
        ...visible.map((entry) => ({
          value: entry.artifact.id,
          label: entry.artifact.name,
          description: `${entry.artifact.id} · ${runLabels[entry.run.state]} · ${entry.artifact.bytes} bytes${entry.provenanceId ? " · 来歴あり（成功の証明ではありません）" : " · 来歴不明"}`,
        })),
        ...(offset ? [{ value: "newer", label: "新しい30件へ" }] : []),
        ...(page.length === 30
          ? [{ value: "older", label: "古い30件へ" }]
          : []),
      ]);
      if (selected === "older") offset += 30;
      else if (selected === "newer") offset -= 30;
      else return visible.find((entry) => entry.artifact.id === selected);
    }
  }

  private async selectArtifact(
    filter: (artifact: Artifact) => boolean,
    title: string,
  ): Promise<{ artifact: Artifact; runId: string } | undefined> {
    let runOffset = 0;
    let offset = 0;
    while (true) {
      const runs = this.app.artifactRuns(runOffset);
      const records = new Map<string, { artifact: Artifact; runId: string }>();
      for (const run of runs)
        for (const artifact of this.app.view(run.id).artifacts)
          if (filter(artifact) && !records.has(artifact.id))
            records.set(artifact.id, { artifact, runId: run.id });
      const items = [...records.values()];
      const page = items.slice(offset, offset + 30);
      if (!page.length && !runOffset && runs.length < 30) {
        this.dialogs.notice("保存済みの資料・検索結果はありません。");
        return;
      }
      const selected = await this.dialogs.choose(title, [
        ...page.map(({ artifact }) => ({
          value: artifact.id,
          label: artifact.name,
          description: `${artifact.id} · ${artifact.bytes} bytes${this.app.session.context?.excludedSourceIds?.includes(artifact.id) ? " · 除外済み（履歴）" : ""}`,
        })),
        ...(offset ? [{ value: "back", label: "前の30件" }] : []),
        ...(items.length > offset + 30
          ? [{ value: "next", label: "次の30件" }]
          : []),
        ...(runs.length === 30
          ? [{ value: "older", label: "さらに古い作業から選ぶ" }]
          : []),
        ...(runOffset ? [{ value: "latest", label: "最近の作業に戻る" }] : []),
      ]);
      if (selected === "next") offset += 30;
      else if (selected === "back") offset -= 30;
      else if (selected === "older") {
        runOffset += 30;
        offset = 0;
      } else if (selected === "latest") {
        runOffset = 0;
        offset = 0;
      } else return page.find(({ artifact }) => artifact.id === selected);
    }
  }
}
