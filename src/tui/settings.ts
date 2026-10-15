import type { Application } from "../application.js";
import { validateConfig, type Config } from "../config.js";
import { AgentError } from "../types.js";
import { catalog } from "../interactive-services.js";
import type { Conversation } from "../conversations.js";
import type {
  SettingsEdit,
  SettingsField,
  SettingsPosition,
} from "./settings-editor.js";

export interface SettingsUi {
  edit(
    title: string,
    fields: SettingsField[],
    position: SettingsPosition,
  ): Promise<SettingsEdit | undefined>;
  choose(
    title: string,
    choices: { value: string; label: string; description?: string }[],
  ): Promise<string | undefined>;
  prompt(title: string, value?: string): Promise<string | undefined>;
  confirm(title: string): Promise<boolean>;
  notify(text: string): void;
  // Run a slash command such as "login <name>" inside the dialog flow.
  run?(command: string): Promise<void>;
}
interface PendingChange {
  session: boolean;
  path: string[];
  before: unknown;
  after: unknown;
  remove?: boolean;
}
export class SettingsDialog {
  private pending: PendingChange[] = [];
  constructor(
    readonly app: Application,
    readonly ui: SettingsUi,
  ) {}
  async open(): Promise<void> {
    const position: SettingsPosition = { query: "" };
    while (true) {
      const fields = this.fields();
      const edit = await this.ui.edit(
        "設定 · 検索して直接編集",
        fields,
        position,
      );
      if (!edit) break;
      try {
        position.notice = "";
        if (edit.text === undefined) {
          await this.add(edit.value);
          position.notice =
            "値の変更と検査の追加は、閉じる際にまとめて確認します。";
        } else await this.saveField(edit.value, edit.text);
      } catch (error) {
        position.notice = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 300);
        this.ui.notify(position.notice);
      }
    }
    await this.flush();
  }
  // Staged view: saved config/session with every pending change applied.
  private staged(): { config: Config; session: Conversation } {
    const staged = {
      config: structuredClone(this.app.config),
      session: structuredClone(this.app.session),
    };
    for (const change of this.pending) {
      const keys = change.session ? change.path.slice(1) : change.path;
      let target = (change.session
        ? staged.session
        : staged.config) as unknown as Record<string, unknown>;
      for (const key of keys.slice(0, -1)) {
        if (target[key] === undefined) target[key] = {};
        target = target[key] as Record<string, unknown>;
      }
      if (change.remove) delete target[keys.at(-1)!];
      else target[keys.at(-1)!] = change.after;
    }
    return staged;
  }
  // Record one pending change. Editing the same path again updates it, and a
  // change back to the saved value drops it so the diff shows net changes only.
  private stage(
    session: boolean,
    path: string[],
    after: unknown,
    remove = false,
  ): void {
    const keys = session ? path.slice(1) : path;
    let saved: unknown = session ? this.app.session : this.app.config;
    for (const key of keys.slice(0, -1))
      saved = (saved as Record<string, unknown>)?.[key];
    const original = (saved as Record<string, unknown>)?.[keys.at(-1)!];
    const effective = remove ? undefined : after;
    const index = this.pending.findIndex(
      (change) =>
        change.session === session && change.path.join(".") === path.join("."),
    );
    if (JSON.stringify(original) === JSON.stringify(effective)) {
      if (index >= 0) this.pending.splice(index, 1);
      return;
    }
    if (index >= 0) {
      this.pending[index]!.after = effective;
      this.pending[index]!.remove = remove;
    } else
      this.pending.push({ session, path, before: original, after: effective });
  }
  private fields(): SettingsField[] {
    const result: SettingsField[] = [
      {
        value: "connection",
        label: "+ 接続を追加",
        description: "接続 → モデルの順に登録。接続は無効で作成します。",
      },
      {
        value: "model",
        label: "+ モデルを追加",
        description: "登録済み接続にモデルを追加（tools は無効）",
      },
      {
        value: "check",
        label: "+ 検査コマンドを追加",
        description: "閉じる際の確認でこの会話の必須検査にも登録します。",
      },
    ];
    const labels: Record<string, string> = {
      connections: "接続",
      models: "モデル",
      limits: "予算・上限",
      execution: "隔離実行",
      checks: "検査",
      session: "この会話",
      defaults: "既定値",
      routing: "振り分け",
      web: "Web",
      mcp: "MCP",
      retentionDays: "保存日数",
      enabled: "有効",
      allowedData: "送信許可",
      dataClass: "送信区分",
      localOnly: "ローカル限定",
      includeUntracked: "未追跡ファイルを含む",
      maxApiUsd: "API総予算 (USD)",
      maxRequestUsd: "要求予算 (USD)",
      tools: "ツール使用",
    };
    // Looked up as "<top>.<leaf>" first, then "<leaf>", so dynamic names like
    // connections.<name>.enabled resolve to "connections.enabled".
    const descriptions: Record<string, string> = {
      retentionDays: "履歴と作業記録を保持する日数",
      "session.checks": "この会話で変更適用の前に必須の検査",
      "session.dataClass": "この会話から外部へ送信してよい情報の区分",
      "session.localOnly": "有効にするとローカル接続以外へ送信しない",
      "session.includeUntracked": "Git 未追跡ファイルも作業コピーに含める",
      "connections.type": "提供元の種類",
      "connections.enabled": "この接続への送信を許可する",
      "connections.account": "接続で使うアカウント名",
      "connections.billing": "課金形態 subscription/api/local/beta",
      "connections.allowedData": "この接続へ送信してよい情報の区分",
      "connections.secretEnv": "API キーを保持する環境変数の名前",
      "connections.endpoint": "接続先 URL",
      "connections.accountEnv": "アカウント ID を保持する環境変数の名前",
      "connections.requestsPerMinute": "1 分あたりの要求数の上限",
      "connections.maxRequestUsd": "1 要求あたりの料金上限 (USD)",
      "models.connection": "このモデルが使う接続",
      "models.id": "提供元のモデル ID",
      "models.roles": "担当できる役割 lead/worker/reviewer",
      "models.kinds": "対応する作業種別",
      "models.tools": "モデルのツール呼び出しを許可",
      "models.contextWindow": "コンテキスト長 (tokens)",
      "models.maxOutputTokens": "1 応答の最大出力 tokens",
      "models.priority": "自動選択の優先度（大きいほど優先）",
      "limits.maxRequests": "1 会話あたりの要求数の上限",
      "limits.maxApiUsd": "API 従量課金の総予算上限",
      "limits.maxSeconds": "1 作業の最大実行時間 (秒)",
      "limits.maxAgents": "同時に委任できるエージェント数",
      "limits.maxTasks": "1 計画あたりの最大タスク数",
      "limits.maxRepairs": "検査失敗時の自動修正の最大回数",
      "limits.maxInputBytes": "モデル入力の最大バイト数",
      "limits.maxFileBytes": "読み込める 1 ファイルの最大バイト数",
      "limits.maxWorkspaceBytes": "作業コピー全体の最大バイト数",
      "limits.requestTimeoutSeconds": "要求のタイムアウト (秒)",
      "execution.backend": "隔離実行方式 bubblewrap/podman/disabled",
      "execution.image": "Podman イメージ（ダイジェスト固定）",
      "execution.runtimePaths": "隔離環境へ読み取り専用で公開するパス",
      "execution.commandTimeoutSeconds": "検査コマンドのタイムアウト (秒)",
      "execution.maxOutputBytes": "検査出力の最大バイト数",
      "checks.command": "隔離環境で実行する検査コマンド",
      "checks.protectedPaths": "変更を禁止する検査ファイル",
      "defaults.dataClass": "新しい会話の送信区分",
      "defaults.mode": "新しい会話の構成 single/assisted/reviewed",
      "routing.mode": "依頼の振り分け方式 rules/shadow/assisted",
      "routing.classifier": "振り分けに使う clef 接続",
      "web.allowedHosts": "Web 取得を許可するホスト",
      "web.allowedData": "Web 取得へ送信してよい情報の区分",
      "mcp.transport": "接続方式 stdio/http",
      "mcp.command": "stdio で実行するコマンド（絶対パス）",
      "mcp.args": "コマンド引数",
      "mcp.commandSha256": "コマンドの SHA-256",
      "mcp.url": "MCP サーバー URL",
      "mcp.allowedOrigins": "許可するオリジン",
      "mcp.env": "サーバーへ渡す環境変数",
      "mcp.bearerEnv": "Bearer トークンを保持する環境変数",
      "mcp.oauth": "OAuth 認証を使う",
      "mcp.allowedData": "このサーバーへ送信してよい情報の区分",
      "mcp.local": "ネットワーク隔離されたローカル実行",
      "mcp.tools": "ツールごとの承認済みスキーマ",
      "mcp.schemaSha256": "ツールスキーマの SHA-256",
      "mcp.readOnly": "読み取り専用ツールのみ許可",
    };
    const pendingPaths = this.pending.map((change) => change.path.join("."));
    const pending = (path: string) =>
      pendingPaths.some(
        (pending) => path === pending || path.startsWith(`${pending}.`),
      );
    const visit = (node: unknown, path: string[]) => {
      if (node && typeof node === "object" && !Array.isArray(node)) {
        for (const [key, value] of Object.entries(node)) {
          if (path.length || key !== "schemaVersion")
            visit(value, [...path, key]);
        }
        const optional =
          path[0] === "connections" && path.length === 2
            ? ["secretEnv", "accountEnv", "endpoint"]
            : path.join(".") === "execution"
              ? ["image"]
              : path.join(".") === "routing"
                ? ["classifier"]
                : [];
        for (const key of optional)
          if (!(key in node)) visit("", [...path, key]);
        return;
      }
      const joined = path.join(".");
      const leaf = path.at(-1)!;
      const detail =
        descriptions[`${path[0]}.${leaf}`] ?? descriptions[leaf] ?? "";
      result.push({
        value: JSON.stringify(path),
        label: path.map((key) => labels[key] ?? key).join(" / "),
        description: `${detail ? `${detail} · ` : ""}${joined}${Array.isArray(node) ? " · カンマ区切り" : ""}${leaf.endsWith("Env") ? " · 環境変数名のみ（キーの値は入力しない）" : ""}${pending(joined) ? " · 保留" : ""}`,
        current:
          typeof node === "boolean"
            ? node
            : Array.isArray(node)
              ? node.join(", ")
              : String(node ?? ""),
      });
    };
    const staged = this.staged();
    visit(
      {
        checks: staged.session.checks,
        dataClass: staged.session.dataClass,
        localOnly: staged.session.localOnly,
        includeUntracked: staged.session.includeUntracked,
      },
      ["session"],
    );
    visit(staged.config, []);
    return result;
  }
  // Edits are staged, not saved. Session guards still run immediately against
  // the saved session; config edits are validated against the staged config.
  private saveField(key: string, text: string): void {
    const path = JSON.parse(key) as string[];
    const session = path[0] === "session";
    const staged = this.staged();
    const root = session ? staged.session : staged.config;
    const keys = session ? path.slice(1) : path;
    let target = root as unknown as Record<string, unknown>;
    for (const key of keys.slice(0, -1))
      target = target[key] as Record<string, unknown>;
    const field = keys.at(-1)!;
    const before = target[field];
    const value = Array.isArray(before)
      ? text
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : typeof before === "boolean"
        ? text === "true"
        : typeof before === "number"
          ? Number(text)
          : text;
    if (JSON.stringify(before) === JSON.stringify(value)) return;
    if (session) {
      const saved = this.app.session;
      if (field === "dataClass") {
        const levels = ["public", "private", "restricted"];
        if (!levels.includes(text))
          throw new AgentError(
            "CONFIG",
            "送信区分は public / private / restricted です。",
          );
        if (
          saved.latestRunId &&
          levels.indexOf(text) < levels.indexOf(saved.dataClass)
        )
          throw new AgentError(
            "DISCLOSURE_DENIED",
            "既存会話の送信範囲は広げられません。新しい会話を使ってください。",
          );
      }
      if (
        field === "localOnly" &&
        saved.localOnly &&
        !value &&
        saved.latestRunId
      )
        throw new AgentError(
          "DISCLOSURE_DENIED",
          "送信範囲を広げる場合は新しい会話を使ってください。",
        );
      if (
        field === "checks" &&
        (value as string[]).some((name) => !staged.config.checks[name])
      )
        throw new AgentError(
          "CONFIG",
          "未登録の検査があります。先に検査コマンドを追加してください。",
        );
    }
    if (text === "" && before === undefined) return;
    const optional =
      (keys.length === 3 &&
        keys[0] === "connections" &&
        ["secretEnv", "accountEnv", "endpoint"].includes(field)) ||
      keys.join(".") === "execution.image" ||
      keys.join(".") === "routing.classifier";
    const remove = !session && optional && text === "";
    if (!session) {
      const candidate = this.staged().config;
      let next = candidate as unknown as Record<string, unknown>;
      for (const key of keys.slice(0, -1))
        next = next[key] as Record<string, unknown>;
      if (remove) delete next[field];
      else next[field] = value;
      validateConfig(candidate);
    }
    this.stage(session, path, value, remove);
  }
  // Show the pending diff once; apply staged config and session separately.
  private async flush(): Promise<void> {
    if (!this.pending.length) return;
    const show = (value: unknown) => {
      const text =
        value === undefined ? "（未設定）" : (JSON.stringify(value) ?? "");
      return text.length > 80 ? `${text.slice(0, 77)}...` : text;
    };
    const lines = this.pending.map(
      (change) =>
        `${change.path.join(".")}: ${show(change.before)} → ${show(change.after)}`,
    );
    if (
      !(await this.ui.confirm(
        `変更をまとめて保存しますか？\n${lines.join("\n")}\n次の依頼から適用します。`,
      ))
    ) {
      this.ui.notify(`${this.pending.length} 件の変更を破棄しました。`);
      return;
    }
    const staged = this.staged();
    if (this.pending.some((change) => !change.session))
      await this.app.saveConfiguration(validateConfig(staged.config));
    if (this.pending.some((change) => change.session)) {
      for (const change of this.pending.filter((change) => change.session)) {
        const keys = change.path.slice(1);
        let target = this.app.session as unknown as Record<string, unknown>;
        for (const key of keys.slice(0, -1))
          target = target[key] as Record<string, unknown>;
        if (change.remove) delete target[keys.at(-1)!];
        else target[keys.at(-1)!] = change.after;
      }
      this.app.save();
    }
  }
  private async promptModel(
    config: Config,
    connection: string,
  ): Promise<{ name: string; entry: Config["models"][string] } | undefined> {
    const name = await this.ui.prompt("モデルの呼び名");
    if (!name) return;
    if (config.models[name])
      throw new AgentError("CONFIG", "同じ呼び名のモデルがあります。");
    const choice = await this.ui.choose("モデル ID", [
      { value: "manual", label: "ID を入力" },
      {
        value: "catalog",
        label: "SDK カタログから選択（アカウントの利用可否は未確認）",
      },
    ]);
    if (!choice) return;
    let modelId: string | undefined;
    if (choice === "catalog") {
      const models = await catalog(config, this.app.paths, connection);
      modelId = await this.ui.choose(
        "SDK モデル一覧",
        models.map((m) => ({
          value: m.id,
          label: m.id,
          description: m.name,
        })),
      );
    } else modelId = await this.ui.prompt("提供元のモデル ID");
    if (!modelId) return;
    return {
      name,
      entry: {
        connection,
        id: modelId,
        roles: ["lead", "worker", "reviewer"],
        kinds: ["coding", "research", "writing", "chat"],
        tools: false,
        contextWindow: 32000,
        maxOutputTokens: 4096,
        priority: 0,
      },
    };
  }
  private async add(selected: string): Promise<void> {
    const app = this.app;
    const config = structuredClone(app.config);
    if (selected === "connection") {
      const type = await this.ui.choose(
        "接続の種類",
        ["chatgpt", "gemini", "sarashina", "local", "compatible", "clef"].map(
          (value) => ({ value, label: value }),
        ),
      );
      if (!type) return;
      const name = await this.ui.prompt("接続名（英数字・ハイフン）", type);
      if (!name) return;
      if (config.connections[name])
        throw new AgentError(
          "CONFIG",
          "同名の接続があります。編集から変更してください。",
        );
      const endpoint = ["local", "compatible"].includes(type)
        ? await this.ui.prompt(
            "接続先 URL",
            type === "local" ? "http://127.0.0.1:8080/v1" : "https://",
          )
        : undefined;
      if (endpoint === undefined && ["local", "compatible"].includes(type))
        return;
      const secretEnv = !["chatgpt", "local"].includes(type)
        ? await this.ui.prompt(
            "API キーを保持する環境変数の名前（値は入力しない）",
            type === "gemini"
              ? "GEMINI_API_KEY"
              : type === "sarashina"
                ? "SARASHINA_API_KEY"
                : "API_KEY",
          )
        : undefined;
      if (secretEnv === undefined && !["chatgpt", "local"].includes(type))
        return;
      const connection = {
        type: type as Config["connections"][string]["type"],
        enabled: false,
        account: name,
        billing: (type === "local"
          ? "local"
          : type === "chatgpt"
            ? "subscription"
            : type === "sarashina"
              ? "beta"
              : "api") as Config["connections"][string]["billing"],
        allowedData: (type === "local"
          ? ["public", "private", "restricted"]
          : ["public"]) as Config["connections"][string]["allowedData"],
        requestsPerMinute: 60,
        maxRequestUsd: 0,
        ...(endpoint ? { endpoint } : {}),
        ...(secretEnv ? { secretEnv } : {}),
      };
      // The draft carries the new connection so the SDK catalog can query it.
      const draft = {
        ...config,
        connections: { ...config.connections, [name]: connection },
      };
      const model =
        type === "clef" ? undefined : await this.promptModel(draft, name);
      // Defaults as in-flow choices: allowedData, activation, then /login or
      // /probe. Esc keeps the defaults and still saves below.
      if (["chatgpt", "gemini", "compatible", "clef"].includes(type)) {
        const data = await this.ui.choose(`${name} に送信してよい情報`, [
          {
            value: "public",
            label: "public のみ",
            description: "公開情報だけを送信",
          },
          {
            value: "private",
            label: "private まで許可",
            description: "社内情報も送信可",
          },
        ]);
        if (data === "private") connection.allowedData = ["public", "private"];
      }
      const actions = [
        ...(type === "chatgpt"
          ? [
              {
                value: "login",
                label: "有効化して /login を実行",
                description: "ブラウザーで ChatGPT 認証",
              },
            ]
          : model
            ? [
                {
                  value: "probe",
                  label: "有効化して /probe を実行",
                  description: "実際に呼び出して疎通確認（利用枠を消費）",
                },
              ]
            : []),
        { value: "enable", label: "有効化のみ" },
        { value: "skip", label: "無効のままにする" },
      ];
      const activation = await this.ui.choose(
        `${name} を有効にしますか？`,
        actions,
      );
      let follow: string | undefined;
      if (
        activation === "login" ||
        activation === "probe" ||
        activation === "enable"
      )
        connection.enabled = true;
      if (activation === "login") follow = `login ${name}`;
      if (activation === "probe" && model) follow = `probe ${model.name}`;
      await app.saveConfiguration({
        ...draft,
        connections: { ...draft.connections, [name]: connection },
        models: model
          ? { ...draft.models, [model.name]: model.entry }
          : draft.models,
      });
      this.ui.notify(
        model
          ? `${name} とモデル ${model.name} を保存しました。`
          : `${name} を保存しました。`,
      );
      if (follow && this.ui.run) await this.ui.run(follow);
      return;
    }
    if (selected === "model") {
      if (!Object.keys(config.connections).length) {
        await this.add("connection");
        return;
      }
      const connection = await this.ui.choose(
        "接続",
        Object.keys(config.connections).map((value) => ({
          value,
          label: value,
        })),
      );
      if (!connection) return;
      const model = await this.promptModel(config, connection);
      if (!model) return;
      const raw = {
        ...config,
        models: { ...config.models, [model.name]: model.entry },
      };
      await app.saveConfiguration(raw);
      if (
        this.staged().config.connections[connection]!.enabled &&
        this.ui.run
      ) {
        const go = await this.ui.choose(`モデル ${model.name} を保存しました`, [
          {
            value: "probe",
            label: "/probe で疎通・ツールを確認",
            description: "利用枠・予算を消費",
          },
          { value: "later", label: "あとで（tools は確認後に有効化）" },
        ]);
        if (go === "probe") await this.ui.run(`probe ${model.name}`);
      } else
        this.ui.notify(
          "モデルを保存。接続の有効化と /probe の成功を確認して tools を有効にしてください。",
        );
      return;
    }
    if (selected === "check") {
      const name = await this.ui.prompt("検査名");
      if (!name) return;
      const command = await this.ui.prompt("隔離環境で実行する検査コマンド");
      if (!command) return;
      const protectedPaths = await this.ui.prompt(
        "変更を禁止する検査ファイル（カンマ区切り）",
        "",
      );
      if (protectedPaths === undefined) return;
      const entry = {
        command,
        protectedPaths: protectedPaths
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
      };
      const staged = this.staged();
      staged.config.checks[name] = entry;
      validateConfig(staged.config);
      this.stage(false, ["checks", name], entry);
      if (!staged.session.checks.includes(name))
        this.stage(
          true,
          ["session", "checks"],
          [...staged.session.checks, name],
        );
      return;
    }
  }
}
