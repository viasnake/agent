import type { Application } from "../application.js";
import type { Config } from "../config.js";
import { AgentError } from "../types.js";
import { catalog } from "../interactive-services.js";

export interface SettingsUi {
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
    const app = this.app;
    const selected = await this.ui.choose("設定", [
      {
        value: "connection",
        label: "接続を追加",
        description: "01 · 提供元・認証方法を登録（初期状態は無効）",
      },
      {
        value: "connections",
        label: "登録済みの接続",
        description: `${Object.keys(app.config.connections).length} 件 · 有効化・送信許可・予算を編集`,
      },
      {
        value: "model",
        label: "モデルを追加",
        description: "02 · モデル ID を入力、または SDK カタログから選択",
      },
      {
        value: "check",
        label: "検査コマンドを追加",
        description: "03 · コード変更後に必要な検査を設定",
      },
      {
        value: "session",
        label: "この会話の設定",
        description: "必須検査・送信区分・ローカル限定",
      },
      {
        value: "config",
        label: "詳細設定",
        description: "接続・モデル・権限・上限・隔離実行を編集",
      },
    ]);
    const config = structuredClone(app.config);
    if (selected === "connections") {
      if (!Object.keys(config.connections).length) {
        this.ui.notify(
          "接続がありません。/settings → 接続を追加 から登録してください。",
        );
        return;
      }
      const name = await this.ui.choose(
        "登録済みの接続",
        Object.entries(config.connections).map(([value, connection]) => ({
          value,
          label: value,
          description: `${connection.enabled ? "有効" : "無効"} · ${connection.type} · ${connection.allowedData.join(", ")}`,
        })),
      );
      if (name)
        await this.editConfig(
          config,
          ["connections", name],
          config.connections[name],
        );
      return;
    }
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
      return;
    }
    if (selected === "model") {
      const connection = await this.ui.choose(
        "接続",
        Object.keys(config.connections).map((value) => ({
          value,
          label: value,
        })),
      );
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
    if (selected === "session") {
      const field = await this.ui.choose(
        "この会話の設定",
        ["checks", "dataClass", "localOnly", "includeUntracked"].map(
          (value) => ({
            value,
            label: `${value}: ${JSON.stringify(app.session[value as "checks"])}`,
          }),
        ),
      );
      if (!field) return;
      if (field === "dataClass") {
        const value = await this.ui.choose(
          "データ送信区分",
          ["public", "private", "restricted"].map((value) => ({
            value,
            label: value,
          })),
        );
        if (!value) return;
        if (
          app.session.latestRunId &&
          ["public", "private", "restricted"].indexOf(value) <
            ["public", "private", "restricted"].indexOf(app.session.dataClass)
        )
          throw new AgentError(
            "DISCLOSURE_DENIED",
            "既存会話の送信範囲は広げられません。新しい会話を作成してください。",
          );
        app.session.dataClass = value as typeof app.session.dataClass;
      } else if (field === "checks") {
        const name = await this.ui.choose(
          "検査を切り替え",
          Object.keys(config.checks).map((value) => ({
            value,
            label: `${app.session.checks.includes(value) ? "[x]" : "[ ]"} ${value}`,
          })),
        );
        if (name)
          app.session.checks = app.session.checks.includes(name)
            ? app.session.checks.filter((c) => c !== name)
            : [...app.session.checks, name];
      } else if (field === "localOnly") {
        if (app.session.localOnly && app.session.latestRunId)
          throw new AgentError(
            "DISCLOSURE_DENIED",
            "送信範囲を広げる場合は新しい会話を使ってください。",
          );
        app.session.localOnly = !app.session.localOnly;
      } else app.session.includeUntracked = !app.session.includeUntracked;
      app.save();
      return;
    }
    if (selected === "config") await this.editConfig(config, [], config);
  }
  private async editConfig(
    root: Config,
    path: string[],
    node: unknown,
  ): Promise<void> {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      const optional =
        path.join(".") === "execution"
          ? ["image"]
          : path.join(".") === "routing"
            ? ["classifier"]
            : path.length === 2 && path[0] === "connections"
              ? ["secretEnv", "accountEnv", "endpoint"]
              : [];
      const selected = await this.ui.choose(
        `設定 ${path.join(".") || "全般"}`,
        [
          ...Object.entries(node),
          ...optional
            .filter((key) => !(key in node))
            .map((key) => [key, ""] as const),
        ].map(([value, v]) => ({
          value,
          label: value,
          description:
            typeof v === "object"
              ? Array.isArray(v)
                ? JSON.stringify(v)
                : "項目を開く"
              : String(v),
        })),
      );
      if (selected)
        await this.editConfig(
          root,
          [...path, selected],
          (node as Record<string, unknown>)[selected],
        );
      return;
    }
    const value =
      typeof node === "boolean"
        ? await this.ui.choose(path.join("."), [
            { value: "false", label: "false" },
            { value: "true", label: "true" },
          ])
        : await this.ui.prompt(
            `${path.join(".")}${Array.isArray(node) ? "（カンマ区切り）" : ""}`,
            Array.isArray(node) ? node.join(", ") : String(node ?? ""),
          );
    if (value === undefined) return;
    let target: Record<string, unknown> = root as unknown as Record<
      string,
      unknown
    >;
    for (const key of path.slice(0, -1))
      target = target[key] as Record<string, unknown>;
    target[path.at(-1)!] = Array.isArray(node)
      ? value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : typeof node === "number"
        ? Number(value)
        : typeof node === "boolean"
          ? value === "true"
          : value;
    if (
      await this.ui.confirm(
        `${path.join(".")} を ${value} に変更しますか？\n次の依頼から適用されます。`,
      )
    )
      await this.app.saveConfiguration(root);
  }
}
