import type { Application } from "../application.js";
import { validateConfig } from "../config.js";
import { AgentError } from "../types.js";
import { catalog } from "../interactive-services.js";
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
}
export class SettingsDialog {
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
      if (!edit) return;
      try {
        position.notice = "";
        if (edit.text === undefined) {
          await this.add(edit.value);
          position.notice =
            "登録内容は一覧に反映されます。送信許可・予算を確認して接続を有効化し、/probe で疎通を確認してください（利用枠を消費）。";
        } else await this.saveField(edit.value, edit.text);
      } catch (error) {
        position.notice = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 300);
        this.ui.notify(position.notice);
      }
    }
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
      { value: "check", label: "+ 検査コマンドを追加" },
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
      result.push({
        value: JSON.stringify(path),
        label: path.map((key) => labels[key] ?? key).join(" / "),
        description: `${path.join(".")}${Array.isArray(node) ? " · カンマ区切り" : ""}${path.at(-1)?.endsWith("Env") ? " · 環境変数名のみ（キーの値は入力しない）" : ""}`,
        current:
          typeof node === "boolean"
            ? node
            : Array.isArray(node)
              ? node.join(", ")
              : String(node ?? ""),
      });
    };
    visit(
      {
        checks: this.app.session.checks,
        dataClass: this.app.session.dataClass,
        localOnly: this.app.session.localOnly,
        includeUntracked: this.app.session.includeUntracked,
      },
      ["session"],
    );
    visit(this.app.config, []);
    return result;
  }
  private async saveField(key: string, text: string): Promise<void> {
    const path = JSON.parse(key) as string[];
    const session = path[0] === "session";
    const root = structuredClone(session ? this.app.session : this.app.config);
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
      if (field === "dataClass") {
        const levels = ["public", "private", "restricted"];
        if (!levels.includes(text))
          throw new AgentError(
            "CONFIG",
            "送信区分は public / private / restricted です。",
          );
        if (
          this.app.session.latestRunId &&
          levels.indexOf(text) < levels.indexOf(this.app.session.dataClass)
        )
          throw new AgentError(
            "DISCLOSURE_DENIED",
            "既存会話の送信範囲は広げられません。新しい会話を使ってください。",
          );
      }
      if (
        field === "localOnly" &&
        before &&
        !value &&
        this.app.session.latestRunId
      )
        throw new AgentError(
          "DISCLOSURE_DENIED",
          "送信範囲を広げる場合は新しい会話を使ってください。",
        );
      if (
        field === "checks" &&
        (value as string[]).some((name) => !this.app.config.checks[name])
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
    if (!session && optional && text === "") delete target[field];
    else target[field] = value;
    const validated = session ? undefined : validateConfig(root);
    if (
      path.join(".") !== "retentionDays" &&
      !(await this.ui.confirm(
        `${path.join(".")}\n${JSON.stringify(before ?? "")} → ${JSON.stringify(value)}\n次の依頼から適用します。`,
      ))
    )
      return;
    if (session) {
      Object.assign(this.app.session, { [field]: value });
      this.app.save();
    } else await this.app.saveConfiguration(validated);
  }
  private async add(
    selected: string,
    preferredConnection?: string,
  ): Promise<void> {
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
      const raw = {
        ...config,
        connections: {
          ...config.connections,
          [name]: {
            type,
            enabled: false,
            account: name,
            billing:
              type === "local"
                ? "local"
                : type === "chatgpt"
                  ? "subscription"
                  : type === "sarashina"
                    ? "beta"
                    : "api",
            allowedData:
              type === "local"
                ? ["public", "private", "restricted"]
                : ["public"],
            ...(endpoint ? { endpoint } : {}),
            ...(secretEnv ? { secretEnv } : {}),
          },
        },
      };
      await app.saveConfiguration(raw);
      this.ui.notify(
        "接続を追加しました。編集画面で送信区分・予算を確認して有効にしてください。",
      );
      await this.add("model", name);
      return;
    }
    if (selected === "model") {
      if (!Object.keys(config.connections).length) {
        await this.add("connection");
        return;
      }
      const connection =
        preferredConnection ??
        (await this.ui.choose(
          "接続",
          Object.keys(config.connections).map((value) => ({
            value,
            label: value,
          })),
        ));
      if (!connection) return;
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
        const models = await catalog(config, app.paths, connection);
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
      const raw = {
        ...config,
        models: {
          ...config.models,
          [name]: {
            connection,
            id: modelId,
            roles: ["lead", "worker", "reviewer"],
            kinds: ["coding", "research", "writing", "chat"],
            tools: false,
          },
        },
      };
      await app.saveConfiguration(raw);
      this.ui.notify(
        "モデルを保存。/probe の成功を確認して tools を有効にしてください。",
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
      config.checks[name] = {
        command,
        protectedPaths: protectedPaths
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
      };
      if (
        await this.ui.confirm(
          `検査 ${name}: ${command}\nこの会話の必須検査に追加しますか？`,
        )
      ) {
        await app.saveConfiguration(config);
        if (!app.session.checks.includes(name)) app.session.checks.push(name);
        app.save();
      }
      return;
    }
  }
}
