import { useEffect, useState } from "react";
import type { ModelLogin } from "../src/model-auth.js";
import type { AgentService } from "../src/service.js";
import type { SettingsInput } from "../src/settings.js";
import { api } from "./api.js";
type PublicSettings = ReturnType<AgentService["management"]>;
type Tab = "models" | "mcp" | "agent";
function editable(s: PublicSettings): SettingsInput {
  return {
    revision: s.revision,
    defaultModel: s.defaultModel,
    instructions: s.instructions,
    limits: s.limits,
    models: s.models.map(({ id, provider, model, auth }) => ({
      id,
      provider,
      model,
      auth,
    })),
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
    [dirty, setDirty] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [environments, setEnvironments] = useState<Record<string, string>>({});
  function accept(value: PublicSettings) {
    setSaved(value);
    setDraft(editable(value));
    setDirty(false);
    setEnvironments({});
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "設定を更新できません");
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
        }
        if (["waiting", "exchanging"].includes(next.state))
          timer = setTimeout(() => void poll(), 1000);
      } catch {
        if (!disposed)
          setError(
            "認証状態を確認できません。認証を中止してやり直してください。",
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
    setNotice("");
  }
  async function save() {
    if (!draft) return;
    await perform(async () => {
      const input = structuredClone(draft);
      for (const server of input.mcp)
        if (environments[server.id] !== undefined)
          server.env = JSON.parse(environments[server.id] || "{}");
      accept(await api<PublicSettings>("/api/settings", "PUT", input));
      setNotice("保存しました。次の実行開始時に反映します。");
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
      accept(
        await api<PublicSettings>(
          `/api/settings/mcp/${id}/${action}`,
          "POST",
          {},
        ),
      );
      setNotice(
        action === "disconnect"
          ? "認証情報を解除しました。"
          : "接続テストが終了しました。",
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
          会話に戻る
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
        {error && (
          <p className="alert theme-danger" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {saved?.pending && (
          <p className="small fg-2" role="status">
            設定の反映待ち：次の実行開始時に適用
          </p>
        )}
        {login && (
          <section className="settings-card" aria-label="ChatGPT 認証">
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
                    ChatGPT の認証を開く
                  </a>
                )}
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
                <div className="settings-actions">
                  <button
                    className="btn-solid theme-primary"
                    disabled={busy || !callbackUrl || login.state !== "waiting"}
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
                {draft.models.map((model, index) => {
                  const current = saved?.models.find((m) => m.id === model.id);
                  const update = (patch: Partial<typeof model>) =>
                    change((s) => ({
                      ...s,
                      models: s.models.map((m) =>
                        m.id === model.id ? { ...m, ...patch } : m,
                      ),
                    }));
                  return (
                    <fieldset key={model.id} className="settings-card">
                      <legend>モデル {index + 1}</legend>
                      <label className="form-label">
                        プロバイダー
                        <select
                          className="form-control"
                          aria-label="プロバイダー"
                          value={model.provider}
                          disabled
                        >
                          <option value="openai">OpenAI</option>
                        </select>
                      </label>
                      <label className="form-label">
                        モデル ID
                        <input
                          className="form-control"
                          value={model.model}
                          onChange={(e) => update({ model: e.target.value })}
                        />
                      </label>
                      <label className="form-label">
                        認証方式
                        <select
                          className="form-control"
                          aria-label="認証方式"
                          value={model.auth ?? "api_key"}
                          onChange={(e) =>
                            update({
                              auth: e.target.value as "api_key" | "oauth",
                              key: undefined,
                            })
                          }
                        >
                          <option value="api_key">API キー</option>
                          <option value="oauth">ChatGPT（OAuth）</option>
                        </select>
                      </label>
                      {model.auth !== "oauth" && (
                        <>
                          <label className="form-label">
                            API キー
                            <input
                              className="form-control"
                              type="password"
                              autoComplete="new-password"
                              value={model.key ?? ""}
                              placeholder={
                                current?.hasKey
                                  ? "登録済み（変更するときだけ入力）"
                                  : "未登録"
                              }
                              onChange={(e) => update({ key: e.target.value })}
                            />
                          </label>
                        </>
                      )}
                      <label className="settings-check">
                        <input
                          type="radio"
                          name="default-model"
                          checked={draft.defaultModel === model.id}
                          onChange={() =>
                            change((s) => ({ ...s, defaultModel: model.id }))
                          }
                        />
                        既定のモデル
                      </label>
                      <p className="small fg-2">
                        {current?.status ?? "未保存"}
                      </p>
                      <div className="settings-actions">
                        <button
                          className="btn-outline theme-secondary btn-sm"
                          disabled={
                            dirty ||
                            !(model.auth === "oauth"
                              ? current?.authorized
                              : current?.hasKey)
                          }
                          onClick={() => {
                            if (
                              window.confirm(
                                "少量の推論を実行します。選択した認証方式の利用枠または API 料金を消費します。続けますか？",
                              )
                            )
                              void perform(async () => {
                                accept(
                                  await api<PublicSettings>(
                                    `/api/settings/models/${model.id}/test`,
                                    "POST",
                                    { confirmPaid: true },
                                  ),
                                );
                                setNotice("接続テストが終了しました。");
                              });
                          }}
                        >
                          接続テスト（推論あり）
                        </button>
                        {model.auth === "oauth" ? (
                          <>
                            <button
                              className="btn-outline theme-primary btn-sm"
                              disabled={dirty}
                              onClick={() =>
                                void perform(async () => {
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
                              Continue with ChatGPT
                            </button>
                            <button
                              className="btn-text theme-secondary btn-sm"
                              disabled={dirty || !current?.authorized}
                              onClick={() =>
                                void perform(async () => {
                                  accept(
                                    await api<PublicSettings>(
                                      `/api/settings/models/${model.id}/disconnect`,
                                      "POST",
                                      {},
                                    ),
                                  );
                                  setLogin(undefined);
                                })
                              }
                            >
                              ChatGPT 認証を解除
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="btn-text theme-secondary btn-sm"
                              onClick={() => update({ key: "" })}
                            >
                              API キーを削除
                            </button>
                          </>
                        )}
                        <button
                          className="btn-text theme-danger btn-sm"
                          onClick={() =>
                            change((s) => ({
                              ...s,
                              models: s.models.filter((m) => m.id !== model.id),
                              defaultModel:
                                s.defaultModel === model.id
                                  ? null
                                  : s.defaultModel,
                            }))
                          }
                        >
                          モデルを削除
                        </button>
                      </div>
                    </fieldset>
                  );
                })}
                <button
                  className="btn-outline theme-secondary"
                  disabled={draft.models.length >= 10}
                  onClick={() => {
                    const id = crypto.randomUUID();
                    change((s) => ({
                      ...s,
                      models: [
                        ...s.models,
                        { id, provider: "openai", model: "" },
                      ],
                      defaultModel: s.defaultModel ?? id,
                    }));
                  }}
                >
                  モデルを追加
                </button>
              </>
            )}
            {tab === "mcp" && (
              <>
                {draft.mcp.map((server, index) => {
                  const current = saved?.mcp.find((m) => m.id === server.id);
                  const update = (patch: Partial<typeof server>) =>
                    change((s) => ({
                      ...s,
                      mcp: s.mcp.map((m) =>
                        m.id === server.id ? { ...m, ...patch } : m,
                      ),
                    }));
                  return (
                    <fieldset key={server.id} className="settings-card">
                      <legend>MCP {index + 1}</legend>
                      <label className="form-label">
                        名前
                        <input
                          className="form-control"
                          value={server.name}
                          onChange={(e) => update({ name: e.target.value })}
                        />
                      </label>
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
                          <option value="stdio">stdio（作業ユーザー）</option>
                          <option value="http">Streamable HTTP</option>
                        </select>
                      </label>
                      {server.transport === "stdio" ? (
                        <>
                          <label className="form-label">
                            コマンド（絶対パス）
                            <input
                              className="form-control"
                              value={server.command}
                              onChange={(e) =>
                                update({ command: e.target.value })
                              }
                            />
                          </label>
                          <label className="form-label">
                            引数（1行に1つ）
                            <textarea
                              className="form-control"
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
                          <label className="form-label">
                            環境変数（JSON・全置換）
                            <input
                              className="form-control"
                              type="password"
                              autoComplete="new-password"
                              value={environments[server.id] ?? ""}
                              placeholder={
                                current?.envNames.length
                                  ? `登録済み: ${current.envNames.join(", ")}`
                                  : '{"TOKEN":"…"}'
                              }
                              onChange={(e) => {
                                setEnvironments((v) => ({
                                  ...v,
                                  [server.id]: e.target.value,
                                }));
                                setDirty(true);
                              }}
                            />
                          </label>
                          <p className="small fg-2">
                            環境変数の資格情報は作業ユーザーへ委譲され、同じユーザーの
                            Shell からもアクセスされ得ます。
                          </p>
                        </>
                      ) : (
                        <>
                          <label className="form-label">
                            HTTPS URL
                            <input
                              className="form-control"
                              type="url"
                              value={server.url}
                              onChange={(e) => update({ url: e.target.value })}
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
                              <option value="bearer">Bearer Token</option>
                              <option value="oauth">OAuth 2.0</option>
                            </select>
                          </label>
                          {server.auth === "bearer" && (
                            <label className="form-label">
                              Bearer Token
                              <input
                                className="form-control"
                                type="password"
                                autoComplete="new-password"
                                value={server.bearer ?? ""}
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
                                Client ID（動的登録なら空欄）
                                <input
                                  className="form-control"
                                  value={server.clientId}
                                  onChange={(e) =>
                                    update({ clientId: e.target.value })
                                  }
                                />
                              </label>
                              <label className="form-label">
                                Client Secret（必要な場合）
                                <input
                                  className="form-control"
                                  type="password"
                                  autoComplete="new-password"
                                  value={server.clientSecret ?? ""}
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
                          <details>
                            <summary>詳細設定</summary>
                            <label className="form-label">
                              社内・VPN 接続を許可するホスト（1行に1つ）
                              <textarea
                                className="form-control"
                                value={server.privateHosts.join("\n")}
                                onChange={(e) =>
                                  update({
                                    privateHosts: e.target.value
                                      ? e.target.value.split("\n")
                                      : [],
                                  })
                                }
                              />
                            </label>
                            <p className="small fg-2">
                              指定ホストへのプライベートネットワーク接続を許可します。認証サーバーは別途指定します。loopback・リンクローカルは許可できません。
                            </p>
                          </details>
                        </>
                      )}
                      <p className="small fg-2" role="status">
                        {current?.status.message ?? "未保存"}
                      </p>
                      {!!current?.status.tools.length && (
                        <details>
                          <summary>
                            公開ツール（{current.status.tools.length}）
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
                          接続テスト
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
                    </fieldset>
                  );
                })}
                <button
                  className="btn-outline theme-secondary"
                  disabled={draft.mcp.length >= 10}
                  onClick={() =>
                    change((s) => ({
                      ...s,
                      mcp: [
                        ...s.mcp,
                        {
                          id: crypto.randomUUID(),
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
                    }))
                  }
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
        {dirty && <span className="small fg-2">未保存</span>}
      </footer>
    </section>
  );
}
