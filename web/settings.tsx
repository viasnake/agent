import { useNotify } from "./notifications.js";
import { useEffect, useState } from "react";
import type { ModelLogin } from "../src/model-auth.js";
import type { AgentService } from "../src/service.js";
import type { SettingsInput } from "../src/settings.js";
import { api } from "./api.js";
type PublicSettings = ReturnType<AgentService["management"]>;
const secretMask = "••••••••";
type EnvironmentRow = { name: string; value?: string };
type Tab = "models" | "mcp" | "agent";
function editable(s: PublicSettings): SettingsInput {
  return {
    revision: s.revision,
    defaultModel: s.defaultModel,
    instructions: s.instructions,
    limits: s.limits,
    models: s.models.map(
      ({
        id,
        provider,
        model,
        auth,
        name,
        project,
        location,
        region,
        profile,
        images,
      }) => ({
        id,
        provider,
        name,
        model,
        auth,
        project,
        location,
        region,
        profile,
        images,
      }),
    ),
    mcp: s.mcp.map(
      ({
        id,
        name,
        enabled,
        transport,
        command,
        args,
        url,
        privateHosts,
        auth,
        clientId,
      }) => ({
        id,
        name,
        enabled,
        transport,
        command,
        args,
        url,
        privateHosts,
        auth,
        clientId,
      }),
    ),
  };
}
export function Settings({ onClose }: { onClose: () => void }) {
  const notify = useNotify();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggle(id: string, open: boolean) {
    setExpanded((old) => {
      const next = new Set(old);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  const [login, setLogin] = useState<ModelLogin>();
  const [callbackUrl, setCallbackUrl] = useState("");
  const loginPending =
    !!login && ["waiting", "exchanging"].includes(login.state);
  const [saved, setSaved] = useState<PublicSettings>();
  const [draft, setDraft] = useState<SettingsInput>();
  const [tab, setTab] = useState<Tab>(
    new URLSearchParams(location.search).get("settings") === "mcp"
      ? "mcp"
      : "models",
  );
  const [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  const [environments, setEnvironments] = useState<
    Record<string, EnvironmentRow[]>
  >({});
  function accept(value: PublicSettings) {
    setSaved(value);
    setDraft(editable(value));
    setDirty(false);
    setEnvironments({});
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true);

    try {
      await action();
    } catch (e) {
      notify(e instanceof Error ? e.message : "設定を更新できません", true);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void perform(async () => {
      accept(await api<PublicSettings>("/api/settings"));
      setLogin(
        (await api<ModelLogin | null>("/api/settings/model-login")) ??
          undefined,
      );
    });
  }, []);
  useEffect(() => {
    if (login?.state === "error") notify(login.message, true);
  }, [login?.id, login?.state, notify]);
  useEffect(() => {
    if (!loginPending || !login) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api<ModelLogin>(
          `/api/settings/model-login/${login!.id}`,
        );
        if (disposed) return;
        setLogin(next);
        if (next.state === "complete") {
          accept(await api<PublicSettings>("/api/settings"));
          setCallbackUrl("");
          notify(
            `${next.provider === "github-copilot" ? "GitHub Copilot" : "ChatGPT"} に接続しました。`,
          );
        }
        if (["waiting", "exchanging"].includes(next.state))
          timer = setTimeout(() => void poll(), 1000);
      } catch {
        if (!disposed)
          notify(
            "認証状態を確認できません。認証を中止してやり直してください。",
            true,
          );
      }
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [login?.id, loginPending]);
  function change(update: (value: SettingsInput) => SettingsInput) {
    setDraft((value) => (value ? update(value) : value));
    setDirty(true);
  }
  async function persist(value: SettingsInput) {
    const input = structuredClone(value);
    for (const server of input.mcp)
      if (environments[server.id] !== undefined) {
        const rows = environments[server.id]!;
        if (
          new Set(rows.map((r) => r.name)).size !== rows.length ||
          rows.some((r) => !r.name)
        )
          throw new Error("環境変数の名前を確認してください");
        server.envKeep = rows
          .filter((r) => r.value === undefined)
          .map((r) => r.name);
        server.env = Object.fromEntries(
          rows
            .filter((r) => r.value !== undefined)
            .map((r) => [r.name, r.value!]),
        );
      }
    const result = await api<PublicSettings>("/api/settings", "PUT", input);
    accept(result);
    return result;
  }
  async function save() {
    if (!draft) return;
    await perform(async () => {
      await persist(draft);
      notify("保存しました。");
    });
  }
  async function mcpAction(id: string, action: string) {
    await perform(async () => {
      if (action === "oauth") {
        const result = await api<{ url: string }>(
          `/api/settings/mcp/${id}/oauth`,
          "POST",
          {},
        );
        location.assign(result.url);
        return;
      }
      const result = await api<PublicSettings>(
        `/api/settings/mcp/${id}/${action}`,
        "POST",
        {},
      );
      accept(result);
      const failed =
        result.mcp.find((m) => m.id === id)?.status.state === "error";
      notify(
        action === "disconnect"
          ? "認証情報を解除しました。"
          : failed
            ? "接続失敗"
            : "接続成功",
        failed,
      );
    });
  }
  return (
    <section className="settings-page" aria-label="設定">
      <header className="conversation-header">
        <h1>設定</h1>
        <button
          className="btn-outline theme-secondary btn-sm ms-auto"
          onClick={() =>
            void perform(async () => {
              if (loginPending && login)
                await api(
                  `/api/settings/model-login/${login.id}/cancel`,
                  "POST",
                  {},
                );
              onClose();
            })
          }
          disabled={busy}
        >
          セッションに戻る
        </button>
      </header>
      <nav className="settings-tabs" aria-label="設定の種類">
        {(
          [
            ["models", "モデル"],
            ["mcp", "MCP"],
            ["agent", "Agent 設定"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={
              tab === id
                ? "btn-solid theme-primary"
                : "btn-text theme-secondary"
            }
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {loginPending && login && (
          <section
            className="settings-card"
            aria-label={
              login.provider === "github-copilot"
                ? "GitHub Copilot 認証"
                : "ChatGPT 認証"
            }
          >
            <p role="status">{login.message}</p>
            {loginPending && (
              <>
                {login.url && (
                  <a
                    className="btn-outline theme-primary"
                    href={login.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {login.provider === "github-copilot"
                      ? "GitHub の認証を開く"
                      : "ChatGPT の認証を開く"}
                  </a>
                )}
                {login.provider === "github-copilot" ? (
                  <p>
                    認証コード:{" "}
                    <code aria-label="認証コード">{login.userCode}</code>
                  </p>
                ) : (
                  <label className="form-label">
                    認証後の URL（localhost に接続できなかった場合）
                    <input
                      className="form-control"
                      type="password"
                      autoComplete="off"
                      value={callbackUrl}
                      onChange={(e) => setCallbackUrl(e.target.value)}
                      placeholder="http://127.0.0.1:1455/auth/callback?..."
                    />
                  </label>
                )}
                <div className="settings-actions">
                  {login.provider !== "github-copilot" && (
                    <button
                      className="btn-solid theme-primary"
                      disabled={
                        busy || !callbackUrl || login.state !== "waiting"
                      }
                      onClick={() =>
                        void perform(async () => {
                          setLogin(
                            await api<ModelLogin>(
                              `/api/settings/model-login/${login.id}`,
                              "POST",
                              { url: callbackUrl },
                            ),
                          );
                          setCallbackUrl("");
                        })
                      }
                    >
                      認証を完了
                    </button>
                  )}
                  <button
                    className="btn-text theme-secondary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        setLogin(
                          await api<ModelLogin>(
                            `/api/settings/model-login/${login.id}/cancel`,
                            "POST",
                            {},
                          ),
                        );
                        setCallbackUrl("");
                        notify("認証を中止しました。");
                      })
                    }
                  >
                    認証を中止
                  </button>
                </div>
              </>
            )}
          </section>
        )}
        {!draft ? (
          <p>読み込み中…</p>
        ) : (
          <fieldset disabled={busy || loginPending} className="settings-fields">
            {tab === "models" && (
              <>
                {draft.models.map((model) => {
                  const current = saved?.models.find((m) => m.id === model.id);
                  const update = (patch: Partial<typeof model>) =>
                    change((s) => ({
                      ...s,
                      models: s.models.map((m) =>
                        m.id === model.id ? { ...m, ...patch } : m,
                      ),
                    }));
                  return (
                    <details
                      key={model.id}
                      className="settings-disclosure"
                      open={expanded.has(model.id)}
                      onToggle={(e) => toggle(model.id, e.currentTarget.open)}
                    >
                      <summary>
                        <span>
                          {model.name ||
                            (model.provider === "github-copilot"
                              ? "GitHub Copilot"
                              : model.auth === "oauth"
                                ? "ChatGPT"
                                : model.provider === "openai"
                                  ? "OpenAI API"
                                  : model.provider)}
                        </span>
                        <small>
                          {current?.status === "未確認" ? "" : current?.status}
                        </small>
                      </summary>
                      <div className="settings-card">
                        <label className="form-label">
                          プロバイダー
                          <select
                            className="form-control"
                            aria-label="プロバイダー"
                            value={model.provider}
                            onChange={(e) => {
                              const provider = e.target
                                .value as typeof model.provider;
                              update({
                                provider,
                                model: undefined,
                                key: "",
                                auth:
                                  provider === "github-copilot"
                                    ? "oauth"
                                    : provider === "google-vertex"
                                      ? "adc"
                                      : provider === "amazon-bedrock"
                                        ? "aws"
                                        : "api_key",
                                project: undefined,
                                location:
                                  provider === "google-vertex"
                                    ? "global"
                                    : undefined,
                                region:
                                  provider === "amazon-bedrock"
                                    ? "us-east-1"
                                    : undefined,
                                profile: undefined,
                                images: undefined,
                              });
                            }}
                          >
                            <option value="openai">OpenAI</option>
                            <option value="github-copilot">
                              GitHub Copilot
                            </option>
                            <option value="anthropic">Anthropic</option>
                            <option value="google">Gemini</option>
                            <option value="google-vertex">Vertex AI</option>
                            <option value="amazon-bedrock">
                              Amazon Bedrock
                            </option>
                          </select>
                        </label>
                        <label className="form-label">
                          名前
                          <input
                            className="form-control"
                            aria-label="接続名"
                            placeholder={
                              model.provider === "github-copilot"
                                ? "GitHub Copilot"
                                : model.auth === "oauth"
                                  ? "ChatGPT"
                                  : model.provider === "openai"
                                    ? "OpenAI API"
                                    : model.provider
                            }
                            value={model.name ?? ""}
                            onChange={(e) => update({ name: e.target.value })}
                          />
                        </label>
                        {model.provider === "google-vertex" && (
                          <>
                            <label className="form-label">
                              プロジェクト ID
                              <input
                                className="form-control"
                                aria-label="プロジェクト ID"
                                value={model.project ?? ""}
                                onChange={(e) =>
                                  update({ project: e.target.value })
                                }
                              />
                            </label>
                            <label className="form-label">
                              ロケーション
                              <input
                                className="form-control"
                                aria-label="ロケーション"
                                value={model.location ?? "global"}
                                onChange={(e) =>
                                  update({ location: e.target.value })
                                }
                              />
                            </label>
                          </>
                        )}
                        {model.provider === "amazon-bedrock" && (
                          <>
                            <label className="form-label">
                              リージョン
                              <input
                                className="form-control"
                                aria-label="リージョン"
                                value={model.region ?? ""}
                                onChange={(e) =>
                                  update({ region: e.target.value })
                                }
                              />
                            </label>
                            {model.auth === "aws" && (
                              <label className="form-label">
                                AWS プロファイル
                                <input
                                  className="form-control"
                                  aria-label="AWS プロファイル"
                                  value={model.profile ?? ""}
                                  onChange={(e) =>
                                    update({
                                      profile: e.target.value || undefined,
                                    })
                                  }
                                />
                              </label>
                            )}
                          </>
                        )}
                        <label className="form-label">
                          認証方式
                          <select
                            className="form-control"
                            aria-label="認証方式"
                            value={model.auth ?? "api_key"}
                            onChange={(e) =>
                              update({
                                auth: e.target.value as typeof model.auth,
                                key: "",
                              })
                            }
                          >
                            {!["google-vertex", "github-copilot"].includes(
                              model.provider,
                            ) && <option value="api_key">API キー</option>}
                            {model.provider === "github-copilot" && (
                              <option value="oauth">GitHub（OAuth）</option>
                            )}
                            {model.provider === "openai" && (
                              <option value="oauth">ChatGPT（OAuth）</option>
                            )}
                            {model.provider === "google-vertex" && (
                              <option value="adc">ADC</option>
                            )}
                            {model.provider === "amazon-bedrock" && (
                              <option value="aws">AWS 認証情報</option>
                            )}
                          </select>
                        </label>
                        {!["oauth", "adc", "aws"].includes(
                          model.auth ?? "api_key",
                        ) && (
                          <>
                            <label className="form-label">
                              API キー
                              <input
                                className="form-control"
                                type="password"
                                autoComplete="new-password"
                                value={
                                  model.key ??
                                  (current?.hasKey && current.auth !== "oauth"
                                    ? secretMask
                                    : "")
                                }
                                onFocus={(e) => e.target.select()}
                                placeholder={
                                  current?.hasKey ? "登録済み" : "未登録"
                                }
                                onChange={(e) =>
                                  update({ key: e.target.value })
                                }
                              />
                            </label>
                          </>
                        )}
                        <div className="settings-actions">
                          <button
                            className="btn-outline theme-secondary btn-sm"
                            disabled={
                              dirty ||
                              !(
                                model.auth === "adc" ||
                                model.auth === "aws" ||
                                (model.auth === "oauth"
                                  ? current?.authorized
                                  : current?.hasKey)
                              )
                            }
                            onClick={() => {
                              if (
                                window.confirm(
                                  "テストには利用枠または料金がかかります。実行しますか？",
                                )
                              )
                                void perform(async () => {
                                  const result = await api<PublicSettings>(
                                    `/api/settings/models/${model.id}/test`,
                                    "POST",
                                    { confirmPaid: true },
                                  );
                                  accept(result);
                                  const status =
                                    result.models.find((m) => m.id === model.id)
                                      ?.status ?? "接続失敗";
                                  const failed = status !== "接続成功";
                                  notify(status, failed);
                                });
                            }}
                          >
                            テスト
                          </button>
                          {model.auth === "oauth" ? (
                            <>
                              <button
                                className="btn-outline theme-primary btn-sm"
                                onClick={() =>
                                  void perform(async () => {
                                    if (dirty || !current) await persist(draft);
                                    setCallbackUrl("");
                                    setLogin(
                                      await api<ModelLogin>(
                                        `/api/settings/models/${model.id}/oauth`,
                                        "POST",
                                        {},
                                      ),
                                    );
                                  })
                                }
                              >
                                {model.provider === "github-copilot"
                                  ? "Continue with GitHub"
                                  : "Continue with ChatGPT"}
                              </button>
                              {model.provider === "github-copilot" &&
                                current?.authorized && (
                                  <button
                                    className="btn-text theme-secondary btn-sm"
                                    disabled={dirty}
                                    onClick={() =>
                                      void perform(async () => {
                                        accept(
                                          await api<PublicSettings>(
                                            `/api/settings/models/${model.id}/disconnect`,
                                            "POST",
                                            {},
                                          ),
                                        );
                                        if (login?.modelId === model.id)
                                          setLogin(undefined);
                                        notify("認証を解除しました。");
                                      })
                                    }
                                  >
                                    認証を解除
                                  </button>
                                )}
                            </>
                          ) : null}
                          <button
                            className="btn-text theme-danger btn-sm"
                            onClick={() =>
                              void perform(async () => {
                                await persist({
                                  ...draft,
                                  models: draft.models.filter(
                                    (m) => m.id !== model.id,
                                  ),
                                  defaultModel:
                                    draft.defaultModel === model.id
                                      ? null
                                      : draft.defaultModel,
                                });
                                if (login?.modelId === model.id)
                                  setLogin(undefined);
                                notify("接続を削除しました。");
                              })
                            }
                          >
                            接続を削除
                          </button>
                        </div>
                      </div>
                    </details>
                  );
                })}
                <button
                  className="btn-outline theme-secondary"
                  disabled={draft.models.length >= 10}
                  onClick={() => {
                    const id = crypto.randomUUID();
                    toggle(id, true);
                    change((s) => ({
                      ...s,
                      models: [
                        ...s.models,
                        { id, provider: "openai", name: "" },
                      ],
                      defaultModel: s.defaultModel ?? id,
                    }));
                  }}
                >
                  接続を追加
                </button>
              </>
            )}
            {tab === "mcp" && (
              <>
                {draft.mcp.map((server) => {
                  const current = saved?.mcp.find((m) => m.id === server.id);
                  const update = (patch: Partial<typeof server>) =>
                    change((s) => ({
                      ...s,
                      mcp: s.mcp.map((m) =>
                        m.id === server.id ? { ...m, ...patch } : m,
                      ),
                    }));
                  return (
                    <details
                      key={server.id}
                      className="settings-disclosure"
                      open={expanded.has(server.id)}
                      onToggle={(e) => toggle(server.id, e.currentTarget.open)}
                    >
                      <summary>
                        <span>{server.name || "新しい MCP"}</span>
                        <small>
                          {!server.enabled
                            ? "無効"
                            : current?.status.state === "untested"
                              ? ""
                              : current?.status.message}
                        </small>
                      </summary>
                      <div className="settings-card">
                        <label className="settings-check">
                          <input
                            type="checkbox"
                            checked={server.enabled}
                            onChange={(e) =>
                              update({ enabled: e.target.checked })
                            }
                          />
                          有効
                        </label>
                        <label className="form-label">
                          名前
                          <input
                            className="form-control"
                            value={server.name}
                            onChange={(e) => update({ name: e.target.value })}
                          />
                        </label>
                        <label className="form-label">
                          接続方式
                          <select
                            className="form-control"
                            aria-label="接続方式"
                            value={server.transport}
                            onChange={(e) =>
                              update({
                                transport: e.target.value as "stdio" | "http",
                                auth: "none",
                              })
                            }
                          >
                            <option value="stdio">stdio</option>
                            <option value="http">Streamable HTTP</option>
                          </select>
                        </label>
                        {server.transport === "stdio" ? (
                          <>
                            <label className="form-label">
                              コマンド
                              <input
                                className="form-control"
                                placeholder="/usr/bin/npx"
                                value={server.command}
                                onChange={(e) =>
                                  update({ command: e.target.value })
                                }
                              />
                            </label>
                            <label className="form-label">
                              引数
                              <textarea
                                className="form-control"
                                rows={5}
                                placeholder={
                                  "-y\n@modelcontextprotocol/server-filesystem\n/workspace"
                                }
                                value={server.args.join("\n")}
                                onChange={(e) =>
                                  update({
                                    args: e.target.value
                                      ? e.target.value.split("\n")
                                      : [],
                                  })
                                }
                              />
                            </label>
                            <div className="environment-fields">
                              <span>環境変数</span>
                              {(
                                environments[server.id] ??
                                current?.envNames.map<EnvironmentRow>(
                                  (name) => ({
                                    name,
                                  }),
                                ) ??
                                []
                              ).map((row: EnvironmentRow, index, rows) => {
                                const editRows = (next: EnvironmentRow[]) => {
                                  setEnvironments((v) => ({
                                    ...v,
                                    [server.id]: next,
                                  }));
                                  setDirty(true);
                                };
                                return (
                                  <div className="environment-row" key={index}>
                                    <input
                                      className="form-control"
                                      aria-label={`環境変数名 ${index + 1}`}
                                      placeholder="TOKEN"
                                      value={row.name}
                                      onChange={(e) =>
                                        editRows(
                                          rows.map((r, i) =>
                                            i === index
                                              ? {
                                                  name: e.target.value,
                                                  value: r.value ?? "",
                                                }
                                              : r,
                                          ),
                                        )
                                      }
                                    />
                                    <input
                                      className="form-control"
                                      aria-label={`環境変数の値 ${index + 1}`}
                                      type="password"
                                      autoComplete="new-password"
                                      placeholder="値"
                                      value={row.value ?? secretMask}
                                      onFocus={(e) => e.target.select()}
                                      onChange={(e) =>
                                        editRows(
                                          rows.map((r, i) =>
                                            i === index
                                              ? { ...r, value: e.target.value }
                                              : r,
                                          ),
                                        )
                                      }
                                    />
                                    <button
                                      className="btn-text theme-secondary btn-sm"
                                      aria-label={`環境変数 ${index + 1} を削除`}
                                      onClick={() =>
                                        editRows(
                                          rows.filter((_, i) => i !== index),
                                        )
                                      }
                                    >
                                      削除
                                    </button>
                                  </div>
                                );
                              })}
                              <button
                                className="btn-text theme-secondary btn-sm"
                                onClick={() => {
                                  setEnvironments((v) => ({
                                    ...v,
                                    [server.id]: [
                                      ...(v[server.id] ??
                                        current?.envNames.map<EnvironmentRow>(
                                          (name) => ({ name }),
                                        ) ??
                                        []),
                                      { name: "", value: "" },
                                    ],
                                  }));
                                  setDirty(true);
                                }}
                              >
                                環境変数を追加
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <label className="form-label">
                              URL
                              <input
                                className="form-control"
                                type="url"
                                value={server.url}
                                placeholder="https://mcp.example.com/mcp"
                                onChange={(e) =>
                                  update({
                                    url: e.target.value,
                                    ...(e.target.value.startsWith("http:")
                                      ? { auth: "none" as const }
                                      : {}),
                                  })
                                }
                              />
                            </label>
                            <label className="form-label">
                              認証
                              <select
                                className="form-control"
                                aria-label="MCP 認証"
                                value={server.auth}
                                onChange={(e) =>
                                  update({
                                    auth: e.target.value as typeof server.auth,
                                  })
                                }
                              >
                                <option value="none">なし</option>
                                <option
                                  value="bearer"
                                  disabled={server.url.startsWith("http:")}
                                >
                                  Bearer Token
                                </option>
                                <option
                                  value="oauth"
                                  disabled={server.url.startsWith("http:")}
                                >
                                  OAuth 2.0
                                </option>
                              </select>
                            </label>
                            {server.auth === "bearer" && (
                              <label className="form-label">
                                Bearer Token
                                <input
                                  className="form-control"
                                  type="password"
                                  autoComplete="new-password"
                                  value={
                                    server.bearer ??
                                    (current?.hasBearer ? secretMask : "")
                                  }
                                  onFocus={(e) => e.target.select()}
                                  placeholder={
                                    current?.hasBearer ? "登録済み" : "未登録"
                                  }
                                  onChange={(e) =>
                                    update({ bearer: e.target.value })
                                  }
                                />
                              </label>
                            )}
                            {server.auth === "oauth" && (
                              <>
                                <label className="form-label">
                                  Client ID
                                  <input
                                    className="form-control"
                                    value={server.clientId}
                                    onChange={(e) =>
                                      update({ clientId: e.target.value })
                                    }
                                  />
                                </label>
                                <label className="form-label">
                                  Client Secret
                                  <input
                                    className="form-control"
                                    type="password"
                                    autoComplete="new-password"
                                    value={
                                      server.clientSecret ??
                                      (current?.hasClientSecret
                                        ? secretMask
                                        : "")
                                    }
                                    onFocus={(e) => e.target.select()}
                                    placeholder={
                                      current?.hasClientSecret
                                        ? "登録済み"
                                        : "未登録"
                                    }
                                    onChange={(e) =>
                                      update({ clientSecret: e.target.value })
                                    }
                                  />
                                </label>
                                <p className="small fg-2">
                                  コールバック: {location.origin}/oauth/callback
                                  <br />
                                  {current?.authorized ? "認証済み" : "未認証"}
                                </p>
                              </>
                            )}
                          </>
                        )}
                        {!!current?.status.tools.length && (
                          <details>
                            <summary>
                              ツール（{current.status.tools.length}）
                            </summary>
                            <ul>
                              {current.status.tools.map((t) => (
                                <li key={t.name}>
                                  <strong>{t.name}</strong> {t.description}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                        <div className="settings-actions">
                          <button
                            className="btn-outline theme-secondary btn-sm"
                            disabled={dirty || !current || !server.enabled}
                            onClick={() => void mcpAction(server.id, "test")}
                          >
                            テスト
                          </button>
                          {server.auth === "oauth" && (
                            <button
                              className="btn-outline theme-secondary btn-sm"
                              disabled={dirty || !current}
                              onClick={() => void mcpAction(server.id, "oauth")}
                            >
                              {current?.authorized ? "再認証" : "認証する"}
                            </button>
                          )}
                          <button
                            className="btn-text theme-secondary btn-sm"
                            disabled={dirty || !current}
                            onClick={() =>
                              void mcpAction(server.id, "disconnect")
                            }
                          >
                            認証情報を解除
                          </button>
                          <button
                            className="btn-text theme-danger btn-sm"
                            onClick={() =>
                              change((s) => ({
                                ...s,
                                mcp: s.mcp.filter((m) => m.id !== server.id),
                              }))
                            }
                          >
                            MCP を削除
                          </button>
                        </div>
                      </div>
                    </details>
                  );
                })}
                <button
                  className="btn-outline theme-secondary"
                  disabled={draft.mcp.length >= 10}
                  onClick={() => {
                    const id = crypto.randomUUID();
                    toggle(id, true);
                    change((s) => ({
                      ...s,
                      mcp: [
                        ...s.mcp,
                        {
                          id,
                          name: "",
                          enabled: true,
                          transport: "stdio",
                          command: "",
                          args: [],
                          url: "",
                          privateHosts: [],
                          auth: "none",
                          clientId: "",
                        },
                      ],
                    }));
                  }}
                >
                  MCP を追加
                </button>
              </>
            )}
            {tab === "agent" && (
              <div className="settings-card">
                <label className="form-label">
                  共通指示
                  <textarea
                    className="form-control"
                    rows={7}
                    maxLength={16000}
                    value={draft.instructions}
                    onChange={(e) =>
                      change((s) => ({ ...s, instructions: e.target.value }))
                    }
                  />
                </label>
                {(
                  [
                    ["modelRequests", "モデル呼び出し上限", 60],
                    ["runSeconds", "実行時間の上限（秒）", 3600],
                    ["commandSeconds", "コマンド時間の上限（秒）", 300],
                  ] as const
                ).map(([key, label, max]) => (
                  <label key={key} className="form-label">
                    {label}
                    <input
                      className="form-control"
                      type="number"
                      min={1}
                      max={max}
                      value={draft.limits[key]}
                      onChange={(e) =>
                        change((s) => ({
                          ...s,
                          limits: {
                            ...s.limits,
                            [key]: Number(e.target.value),
                          },
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        )}
      </div>
      <footer className="settings-footer">
        <button
          className="btn-solid theme-primary"
          disabled={busy || loginPending || !dirty}
          onClick={() => void save()}
        >
          {busy ? "処理中…" : "保存"}
        </button>
        <button
          className="btn-text theme-secondary"
          disabled={busy}
          onClick={() =>
            void perform(async () =>
              accept(await api<PublicSettings>("/api/settings")),
            )
          }
        >
          読み直す
        </button>
      </footer>
    </section>
  );
}
