import { AutoModelSettings } from "./auto-model-settings.js";
import {
  SettingsToolbar,
  SettingsDisclosure,
  SettingsEmpty,
} from "./settings-layout.js";
import { Icon } from "./icons.js";
import { CredentialSettings } from "./credentials.js";
import { Skills } from "./skills.js";
import { GitSettings } from "./git-settings.js";
import { NetworkSettings } from "./network-settings.js";
import { MemoryNotes } from "./memory.js";
import type { MemoryDraft, MemorySource } from "./memory.js";
import { useNotify } from "./notifications.js";
import { useEffect, useRef, useState } from "react";
import type { ModelLogin } from "../src/model-auth.js";
import type { AgentService } from "../src/service.js";
import type { SettingsInput } from "../src/settings.js";
import { api } from "./api.js";
type PublicSettings = ReturnType<AgentService["management"]>;
type EnvironmentRow = { name: string; value?: string };
const settingsSections = [
  ["models", "モデル"],
  ["mcp", "MCP"],
  ["credentials", "クレデンシャル"],
  ["git", "Git"],
  ["network", "ネットワーク"],
  ["skills", "Skills"],
  ["agent", "指示・制限"],
  ["memory", "記憶"],
] as const;
type Tab = (typeof settingsSections)[number][0];
export function confirmSettingsExit(unsaved: boolean) {
  return !unsaved || window.confirm("未保存の変更を破棄して設定を閉じますか？");
}
function editable(s: PublicSettings): SettingsInput {
  return {
    revision: s.revision,
    defaultModel: s.defaultModel,
    autoModel: s.autoModel
      ? {
          connectionId: s.autoModel.connectionId,
          light: s.autoModel.light,
          standard: s.autoModel.standard,
          accountId: s.autoModel.accountId,
        }
      : undefined,
    instructions: s.instructions,
    limits: s.limits,
    workCredentials: s.workCredentials.map(({ id, name, kind }) => ({
      id,
      name,
      kind,
    })),
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
export function Settings({
  onOpenSidebar,
  sidebarOpen,
  memoryDraft,
  onSelectSource,
  onDirtyChange,
}: {
  onOpenSidebar: () => void;
  sidebarOpen: boolean;
  memoryDraft?: MemoryDraft | null;
  onSelectSource: (source: MemorySource) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
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
  const [loadFailed, setLoadFailed] = useState(false);
  const [saved, setSaved] = useState<PublicSettings>();
  const [draft, setDraft] = useState<SettingsInput>();
  const [tab, setTab] = useState<Tab>(
    memoryDraft
      ? "memory"
      : new URLSearchParams(location.search).get("settings") === "mcp"
        ? "mcp"
        : "models",
  );
  const [visited, setVisited] = useState(() => new Set<Tab>([tab]));
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [skillsDirty, setSkillsDirty] = useState(false);
  const [gitDirty, setGitDirty] = useState(false);
  const [networkDirty, setNetworkDirty] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  const [environments, setEnvironments] = useState<
    Record<string, EnvironmentRow[]>
  >({});
  const sectionDirty: Partial<Record<Tab, boolean>> = {
    memory: memoryDirty,
    skills: skillsDirty,
    git: gitDirty,
    network: networkDirty,
  };
  const unsaved =
    dirty || memoryDirty || skillsDirty || gitDirty || networkDirty;
  const separateEditor =
    tab === "git" || tab === "network" || tab === "skills" || tab === "memory";
  function canLeave() {
    return confirmSettingsExit(unsaved);
  }
  useEffect(() => {
    onDirtyChange(unsaved);
    return () => onDirtyChange(false);
  }, [unsaved, onDirtyChange]);
  useEffect(() => {
    content.current?.scrollTo({ top: 0 });
    const nav = navigation.current;
    if (!nav) return;
    const reveal = () =>
      nav
        .querySelector<HTMLElement>('[aria-pressed="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [tab]);
  useEffect(() => {
    if (!unsaved) return;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);
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
  async function load() {
    setLoadFailed(false);
    await perform(async () => {
      try {
        const [settings, login] = await Promise.all([
          api<PublicSettings>("/api/settings"),
          api<ModelLogin | null>("/api/settings/model-login"),
        ]);
        accept(settings);
        setLogin(login ?? undefined);
      } catch (error) {
        setLoadFailed(true);
        throw error;
      }
    });
  }
  useEffect(() => {
    void load();
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
    for (const server of [
      ...input.mcp,
      ...(input.workCredentials ?? []).filter((c) => c.kind === "env"),
    ])
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
        <button
          className="mobile-only btn-text theme-secondary btn-sm"
          aria-label="セッション一覧を開く"
          aria-controls="sidebar"
          aria-expanded={sidebarOpen}
          onClick={onOpenSidebar}
        >
          <Icon name="menu" />
        </button>
        <h1>設定</h1>
      </header>
      <div className="settings-layout">
        <nav
          ref={navigation}
          className="settings-navigation gap-1"
          aria-label="設定の種類"
        >
          {settingsSections.map(([id, label]) => (
            <button
              key={id}
              className={
                tab === id
                  ? "btn-solid theme-primary"
                  : "btn-text theme-secondary"
              }
              aria-pressed={tab === id}
              aria-label={label}
              aria-description={sectionDirty[id] ? "編集中" : undefined}
              aria-controls="settings-panel"
              onClick={() => {
                setVisited((old) => new Set([...old, id]));
                setTab(id);
              }}
            >
              {label}
              {sectionDirty[id] && (
                <small className="settings-editing" aria-hidden="true">
                  編集中
                </small>
              )}
            </button>
          ))}
        </nav>
        <div className="settings-main">
          <div className="settings-content" ref={content} id="settings-panel">
            <div className="settings-column">
              <div className="settings-section-heading">
                <h2>{settingsSections.find(([id]) => id === tab)?.[1]}</h2>
              </div>
              {loginPending && login && (
                <section
                  className="settings-card card card-body p-5 gap-4 mb-5"
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
                        <label className="form-label d-block m-0">
                          認証後の URL（localhost に接続できなかった場合）
                          <input
                            className="form-control mt-1"
                            type="text"
                            autoComplete="off"
                            value={callbackUrl}
                            onChange={(e) => setCallbackUrl(e.target.value)}
                            placeholder="http://127.0.0.1:1455/auth/callback?..."
                          />
                        </label>
                      )}
                      <div className="d-flex flex-wrap gap-3">
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
              {visited.has("git") && (
                <div hidden={tab !== "git"}>
                  <GitSettings onDirtyChange={setGitDirty} />
                </div>
              )}
              {visited.has("network") && (
                <div hidden={tab !== "network"}>
                  <NetworkSettings onDirtyChange={setNetworkDirty} />
                </div>
              )}
              {visited.has("skills") && (
                <div hidden={tab !== "skills"}>
                  <Skills onDirtyChange={setSkillsDirty} />
                </div>
              )}
              {visited.has("memory") && (
                <div hidden={tab !== "memory"}>
                  <MemoryNotes
                    initial={memoryDraft ?? undefined}
                    onDirtyChange={setMemoryDirty}
                    onSelect={async (source) => {
                      if (canLeave()) await onSelectSource(source);
                    }}
                  />
                </div>
              )}
              {separateEditor ? null : !draft ? (
                loadFailed ? (
                  <button
                    className="btn-outline theme-secondary"
                    disabled={busy}
                    onClick={() => void load()}
                  >
                    再試行
                  </button>
                ) : (
                  <p role="status">読み込み中…</p>
                )
              ) : (
                <fieldset
                  disabled={busy || loginPending}
                  className="settings-fields"
                >
                  {tab !== "agent" && (
                    <SettingsToolbar>
                      {tab === "models" && (
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
                          追加
                        </button>
                      )}
                      {tab === "mcp" && (
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
                          追加
                        </button>
                      )}
                      {tab === "credentials" &&
                        (
                          [
                            ["env", "環境変数を登録"],
                            ["ssh", "SSH 鍵を登録"],
                          ] as const
                        ).map(([kind, label]) => (
                          <button
                            key={kind}
                            type="button"
                            className="btn-outline theme-secondary"
                            disabled={
                              (draft.workCredentials?.length ?? 0) >= 32
                            }
                            onClick={() => {
                              const id = crypto.randomUUID();
                              toggle(id, true);
                              change((s) => ({
                                ...s,
                                workCredentials: [
                                  ...(s.workCredentials ?? []),
                                  { id, name: "", kind },
                                ],
                              }));
                            }}
                          >
                            {label}
                          </button>
                        ))}
                    </SettingsToolbar>
                  )}
                  {tab === "models" && (
                    <>
                      {!draft.models.length && (
                        <SettingsEmpty>モデル接続はありません</SettingsEmpty>
                      )}
                      {!!draft.models.length && (
                        <AutoModelSettings
                          value={draft.autoModel}
                          saved={saved?.autoModel}
                          models={draft.models}
                          revision={draft.revision}
                          onChange={(autoModel) =>
                            change((s) => ({ ...s, autoModel }))
                          }
                        />
                      )}
                      {draft.models.map((model) => {
                        const current = saved?.models.find(
                          (m) => m.id === model.id,
                        );
                        const update = (patch: Partial<typeof model>) =>
                          change((s) => ({
                            ...s,
                            models: s.models.map((m) =>
                              m.id === model.id ? { ...m, ...patch } : m,
                            ),
                          }));
                        return (
                          <SettingsDisclosure
                            key={model.id}
                            title={
                              model.name ||
                              (model.provider === "github-copilot"
                                ? "GitHub Copilot"
                                : model.auth === "oauth"
                                  ? "ChatGPT"
                                  : model.provider === "openai"
                                    ? "OpenAI API"
                                    : model.provider)
                            }
                            status={
                              current?.status === "未確認"
                                ? ""
                                : current?.status.replace(
                                    /^(ChatGPT|GitHub Copilot) /,
                                    "",
                                  )
                            }
                            open={expanded.has(model.id)}
                            onToggle={(open) => toggle(model.id, open)}
                          >
                            <div className="accordion-body settings-card d-flex flex-column gap-4 p-5 text-break">
                              <fieldset className="settings-form-section">
                                <legend>接続先</legend>
                                <div className="settings-form-grid">
                                  <label className="form-label d-block m-0">
                                    プロバイダー
                                    <select
                                      className="form-control mt-1"
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
                                      <option value="anthropic">
                                        Anthropic
                                      </option>
                                      <option value="google">Gemini</option>
                                      <option value="google-vertex">
                                        Vertex AI
                                      </option>
                                      <option value="amazon-bedrock">
                                        Amazon Bedrock
                                      </option>
                                    </select>
                                  </label>
                                  <label className="form-label d-block m-0">
                                    名前
                                    <input
                                      className="form-control mt-1"
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
                                      onChange={(e) =>
                                        update({ name: e.target.value })
                                      }
                                    />
                                  </label>
                                </div>
                              </fieldset>
                              <fieldset className="settings-form-section">
                                <legend>認証</legend>
                                <div className="settings-form-grid">
                                  <label className="form-label d-block m-0">
                                    認証方式
                                    <select
                                      className="form-control mt-1"
                                      aria-label="認証方式"
                                      value={model.auth ?? "api_key"}
                                      onChange={(e) =>
                                        update({
                                          auth: e.target
                                            .value as typeof model.auth,
                                          key: "",
                                        })
                                      }
                                    >
                                      {![
                                        "google-vertex",
                                        "github-copilot",
                                      ].includes(model.provider) && (
                                        <option value="api_key">
                                          API キー
                                        </option>
                                      )}
                                      {model.provider === "github-copilot" && (
                                        <option value="oauth">
                                          GitHub（OAuth）
                                        </option>
                                      )}
                                      {model.provider === "openai" && (
                                        <option value="oauth">
                                          ChatGPT（OAuth）
                                        </option>
                                      )}
                                      {model.provider === "google-vertex" && (
                                        <option value="adc">ADC</option>
                                      )}
                                      {model.provider === "amazon-bedrock" && (
                                        <option value="aws">
                                          AWS 認証情報
                                        </option>
                                      )}
                                    </select>
                                  </label>

                                  {model.provider === "google-vertex" && (
                                    <>
                                      <label className="form-label d-block m-0">
                                        プロジェクト ID
                                        <input
                                          className="form-control mt-1"
                                          aria-label="プロジェクト ID"
                                          value={model.project ?? ""}
                                          onChange={(e) =>
                                            update({ project: e.target.value })
                                          }
                                        />
                                      </label>
                                      <label className="form-label d-block m-0">
                                        ロケーション
                                        <input
                                          className="form-control mt-1"
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
                                      <label className="form-label d-block m-0">
                                        リージョン
                                        <input
                                          className="form-control mt-1"
                                          aria-label="リージョン"
                                          value={model.region ?? ""}
                                          onChange={(e) =>
                                            update({ region: e.target.value })
                                          }
                                        />
                                      </label>
                                      {model.auth === "aws" && (
                                        <label className="form-label d-block m-0">
                                          AWS プロファイル
                                          <input
                                            className="form-control mt-1"
                                            aria-label="AWS プロファイル"
                                            value={model.profile ?? ""}
                                            onChange={(e) =>
                                              update({
                                                profile:
                                                  e.target.value || undefined,
                                              })
                                            }
                                          />
                                        </label>
                                      )}
                                    </>
                                  )}
                                  {!["oauth", "adc", "aws"].includes(
                                    model.auth ?? "api_key",
                                  ) && (
                                    <>
                                      <label className="form-label d-block m-0 settings-span-all">
                                        API キー
                                        <input
                                          className="form-control mt-1"
                                          type="text"
                                          autoComplete="new-password"
                                          value={
                                            model.key ?? current?.key ?? ""
                                          }
                                          onFocus={(e) => e.target.select()}
                                          placeholder={
                                            current?.hasKey
                                              ? "登録済み"
                                              : "未登録"
                                          }
                                          onChange={(e) =>
                                            update({ key: e.target.value })
                                          }
                                        />
                                      </label>
                                    </>
                                  )}
                                </div>
                              </fieldset>
                              {current?.oauth && (
                                <label className="form-label d-block m-0">
                                  OAuth 認証情報
                                  <textarea
                                    className="form-control mt-1"
                                    aria-label="モデル OAuth 認証情報"
                                    readOnly
                                    rows={6}
                                    value={JSON.stringify(
                                      current.oauth,
                                      null,
                                      2,
                                    )}
                                  />
                                </label>
                              )}
                              <div className="d-flex flex-wrap gap-3">
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
                                        const result =
                                          await api<PublicSettings>(
                                            `/api/settings/models/${model.id}/test`,
                                            "POST",
                                            { confirmPaid: true },
                                          );
                                        accept(result);
                                        const status =
                                          result.models.find(
                                            (m) => m.id === model.id,
                                          )?.status ?? "接続失敗";
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
                                          if (dirty || !current)
                                            await persist(draft);
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
                              </div>
                              <div className="d-flex border-top pt-4 mt-1">
                                <button
                                  className="btn-text theme-danger ms-auto"
                                  onClick={() =>
                                    void perform(async () => {
                                      await persist({
                                        ...draft,
                                        models: draft.models.filter(
                                          (m) => m.id !== model.id,
                                        ),
                                        autoModel:
                                          draft.autoModel?.connectionId ===
                                          model.id
                                            ? null
                                            : draft.autoModel,
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
                          </SettingsDisclosure>
                        );
                      })}
                    </>
                  )}
                  {tab === "credentials" && (
                    <CredentialSettings
                      expanded={expanded}
                      onToggle={toggle}
                      entries={draft.workCredentials ?? []}
                      saved={saved?.workCredentials ?? []}
                      environments={environments}
                      onEnvironments={(id, rows) => {
                        setEnvironments((old) => ({ ...old, [id]: rows }));
                        setDirty(true);
                      }}
                      onChange={(workCredentials) =>
                        change((s) => ({ ...s, workCredentials }))
                      }
                      onError={(message) => notify(message, true)}
                    />
                  )}
                  {tab === "mcp" && (
                    <>
                      {!draft.mcp.length && (
                        <SettingsEmpty>MCP はありません</SettingsEmpty>
                      )}
                      {draft.mcp.map((server) => {
                        const current = saved?.mcp.find(
                          (m) => m.id === server.id,
                        );
                        const update = (patch: Partial<typeof server>) =>
                          change((s) => ({
                            ...s,
                            mcp: s.mcp.map((m) =>
                              m.id === server.id ? { ...m, ...patch } : m,
                            ),
                          }));
                        return (
                          <SettingsDisclosure
                            key={server.id}
                            title={server.name || "新しい MCP"}
                            status={
                              !server.enabled
                                ? "無効"
                                : current?.status.state === "untested"
                                  ? ""
                                  : current?.status.message
                            }
                            open={expanded.has(server.id)}
                            onToggle={(open) => toggle(server.id, open)}
                          >
                            <div className="accordion-body settings-card d-flex flex-column gap-4 p-5 text-break">
                              <fieldset className="settings-form-section">
                                <legend>接続先</legend>
                                <div className="settings-form-grid">
                                  <label className="settings-check settings-span-all">
                                    <input
                                      type="checkbox"
                                      checked={server.enabled}
                                      onChange={(e) =>
                                        update({ enabled: e.target.checked })
                                      }
                                    />
                                    有効
                                  </label>
                                  <label className="form-label d-block m-0">
                                    名前
                                    <input
                                      className="form-control mt-1"
                                      value={server.name}
                                      onChange={(e) =>
                                        update({ name: e.target.value })
                                      }
                                    />
                                  </label>
                                  <label className="form-label d-block m-0">
                                    接続方式
                                    <select
                                      className="form-control mt-1"
                                      aria-label="接続方式"
                                      value={server.transport}
                                      onChange={(e) =>
                                        update({
                                          transport: e.target.value as
                                            | "stdio"
                                            | "http",
                                          auth: "none",
                                        })
                                      }
                                    >
                                      <option value="stdio">stdio</option>
                                      <option value="http">
                                        Streamable HTTP
                                      </option>
                                    </select>
                                  </label>
                                </div>
                              </fieldset>
                              <fieldset className="settings-form-section">
                                <legend>
                                  {server.transport === "stdio"
                                    ? "実行設定"
                                    : "HTTP 接続"}
                                </legend>
                                <div className="settings-form-grid">
                                  {server.transport === "stdio" ? (
                                    <>
                                      <label className="form-label d-block m-0 settings-span-all">
                                        コマンド
                                        <input
                                          className="form-control mt-1"
                                          placeholder="/usr/bin/npx"
                                          value={server.command}
                                          onChange={(e) =>
                                            update({ command: e.target.value })
                                          }
                                        />
                                      </label>
                                      <label className="form-label d-block m-0 settings-span-all">
                                        引数
                                        <textarea
                                          className="form-control mt-1"
                                          aria-label="引数"
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
                                      <div className="environment-fields settings-span-all">
                                        <span>環境変数</span>
                                        {(
                                          environments[server.id] ??
                                          Object.entries(
                                            current?.env ?? {},
                                          ).map(([name, value]) => ({
                                            name,
                                            value,
                                          })) ??
                                          []
                                        ).map(
                                          (
                                            row: EnvironmentRow,
                                            index,
                                            rows,
                                          ) => {
                                            const editRows = (
                                              next: EnvironmentRow[],
                                            ) => {
                                              setEnvironments((v) => ({
                                                ...v,
                                                [server.id]: next,
                                              }));
                                              setDirty(true);
                                            };
                                            return (
                                              <div
                                                className="environment-row"
                                                key={index}
                                              >
                                                <input
                                                  className="form-control mt-1"
                                                  aria-label={`環境変数名 ${index + 1}`}
                                                  placeholder="TOKEN"
                                                  value={row.name}
                                                  onChange={(e) =>
                                                    editRows(
                                                      rows.map((r, i) =>
                                                        i === index
                                                          ? {
                                                              name: e.target
                                                                .value,
                                                              value:
                                                                r.value ?? "",
                                                            }
                                                          : r,
                                                      ),
                                                    )
                                                  }
                                                />
                                                <input
                                                  className="form-control mt-1"
                                                  aria-label={`環境変数の値 ${index + 1}`}
                                                  type="text"
                                                  autoComplete="new-password"
                                                  placeholder="値"
                                                  value={row.value ?? ""}
                                                  onFocus={(e) =>
                                                    e.target.select()
                                                  }
                                                  onChange={(e) =>
                                                    editRows(
                                                      rows.map((r, i) =>
                                                        i === index
                                                          ? {
                                                              ...r,
                                                              value:
                                                                e.target.value,
                                                            }
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
                                                      rows.filter(
                                                        (_, i) => i !== index,
                                                      ),
                                                    )
                                                  }
                                                >
                                                  削除
                                                </button>
                                              </div>
                                            );
                                          },
                                        )}
                                        <button
                                          className="btn-text theme-secondary btn-sm"
                                          onClick={() => {
                                            setEnvironments((v) => ({
                                              ...v,
                                              [server.id]: [
                                                ...(v[server.id] ??
                                                  Object.entries(
                                                    current?.env ?? {},
                                                  ).map(([name, value]) => ({
                                                    name,
                                                    value,
                                                  }))),
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
                                      <label className="form-label d-block m-0 settings-span-all">
                                        URL
                                        <input
                                          className="form-control mt-1"
                                          type="url"
                                          value={server.url}
                                          placeholder="https://mcp.example.com/mcp"
                                          onChange={(e) =>
                                            update({
                                              url: e.target.value,
                                              ...(e.target.value.startsWith(
                                                "http:",
                                              )
                                                ? { auth: "none" as const }
                                                : {}),
                                            })
                                          }
                                        />
                                      </label>
                                      <label className="form-label d-block m-0">
                                        認証
                                        <select
                                          className="form-control mt-1"
                                          aria-label="MCP 認証"
                                          value={server.auth}
                                          onChange={(e) =>
                                            update({
                                              auth: e.target
                                                .value as typeof server.auth,
                                            })
                                          }
                                        >
                                          <option value="none">なし</option>
                                          <option
                                            value="bearer"
                                            disabled={server.url.startsWith(
                                              "http:",
                                            )}
                                          >
                                            Bearer Token
                                          </option>
                                          <option
                                            value="oauth"
                                            disabled={server.url.startsWith(
                                              "http:",
                                            )}
                                          >
                                            OAuth 2.0
                                          </option>
                                        </select>
                                      </label>
                                      {server.auth === "bearer" && (
                                        <label className="form-label d-block m-0">
                                          Bearer Token
                                          <input
                                            className="form-control mt-1"
                                            type="text"
                                            autoComplete="new-password"
                                            value={
                                              server.bearer ??
                                              current?.bearer ??
                                              ""
                                            }
                                            onFocus={(e) => e.target.select()}
                                            placeholder={
                                              current?.hasBearer
                                                ? "登録済み"
                                                : "未登録"
                                            }
                                            onChange={(e) =>
                                              update({ bearer: e.target.value })
                                            }
                                          />
                                        </label>
                                      )}
                                      {server.auth === "oauth" && (
                                        <>
                                          <label className="form-label d-block m-0">
                                            Client ID
                                            <input
                                              className="form-control mt-1"
                                              value={server.clientId}
                                              onChange={(e) =>
                                                update({
                                                  clientId: e.target.value,
                                                })
                                              }
                                            />
                                          </label>
                                          <label className="form-label d-block m-0">
                                            Client Secret
                                            <input
                                              className="form-control mt-1"
                                              type="text"
                                              autoComplete="new-password"
                                              value={
                                                server.clientSecret ??
                                                current?.clientSecret ??
                                                ""
                                              }
                                              onFocus={(e) => e.target.select()}
                                              placeholder={
                                                current?.hasClientSecret
                                                  ? "登録済み"
                                                  : "未登録"
                                              }
                                              onChange={(e) =>
                                                update({
                                                  clientSecret: e.target.value,
                                                })
                                              }
                                            />
                                          </label>
                                          <p className="small fg-2 settings-span-all">
                                            コールバック: {location.origin}
                                            /oauth/callback
                                            <br />
                                            {current?.authorized
                                              ? "認証済み"
                                              : "未認証"}
                                          </p>
                                        </>
                                      )}
                                    </>
                                  )}
                                </div>
                              </fieldset>
                              {current?.oauth && (
                                <label className="form-label d-block m-0">
                                  OAuth 認証情報
                                  <textarea
                                    className="form-control mt-1"
                                    aria-label="MCP OAuth 認証情報"
                                    readOnly
                                    rows={6}
                                    value={JSON.stringify(
                                      current.oauth,
                                      null,
                                      2,
                                    )}
                                  />
                                </label>
                              )}
                              {!!current?.status.tools.length && (
                                <details>
                                  <summary>
                                    ツール（{current.status.tools.length}）
                                  </summary>
                                  <ul>
                                    {current.status.tools.map((t) => (
                                      <li key={t.name}>
                                        <strong>{t.name}</strong>{" "}
                                        {t.description}
                                      </li>
                                    ))}
                                  </ul>
                                </details>
                              )}
                              <div className="d-flex flex-wrap gap-3">
                                <button
                                  className="btn-outline theme-secondary btn-sm"
                                  disabled={
                                    dirty || !current || !server.enabled
                                  }
                                  onClick={() =>
                                    void mcpAction(server.id, "test")
                                  }
                                >
                                  テスト
                                </button>
                                {server.auth === "oauth" && (
                                  <button
                                    className="btn-outline theme-secondary btn-sm"
                                    disabled={dirty || !current}
                                    onClick={() =>
                                      void mcpAction(server.id, "oauth")
                                    }
                                  >
                                    {current?.authorized
                                      ? "再認証"
                                      : "認証する"}
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
                              </div>
                              <div className="d-flex border-top pt-4 mt-1">
                                <button
                                  className="btn-text theme-danger ms-auto"
                                  onClick={() =>
                                    change((s) => ({
                                      ...s,
                                      mcp: s.mcp.filter(
                                        (m) => m.id !== server.id,
                                      ),
                                    }))
                                  }
                                >
                                  MCP を削除
                                </button>
                              </div>
                            </div>
                          </SettingsDisclosure>
                        );
                      })}
                    </>
                  )}
                  {tab === "agent" && (
                    <>
                      <div className="settings-card card card-body p-5 gap-4 mb-5">
                        <h3 className="fs-md fw-semibold m-0">共通指示</h3>
                        <textarea
                          className="form-control mt-1"
                          aria-label="共通指示"
                          rows={7}
                          maxLength={16000}
                          value={draft.instructions}
                          onChange={(e) =>
                            change((s) => ({
                              ...s,
                              instructions: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <div className="settings-card card card-body p-5 gap-4 mb-5">
                        <h3 className="fs-md fw-semibold m-0">実行上限</h3>
                        <div className="settings-form-grid">
                          {(
                            [
                              ["modelRequests", "モデル呼び出し上限", 60],
                              ["runSeconds", "実行時間の上限（秒）", 3600],
                              [
                                "commandSeconds",
                                "コマンド時間の上限（秒）",
                                300,
                              ],
                            ] as const
                          ).map(([key, label, max]) => (
                            <label
                              key={key}
                              className={`form-label d-block m-0 ${key === "modelRequests" ? "settings-span-all" : ""}`}
                            >
                              {label}
                              <input
                                className="form-control mt-1"
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
                      </div>
                    </>
                  )}
                </fieldset>
              )}
            </div>
          </div>
          {(dirty || !separateEditor) && (
            <footer className="settings-footer" aria-label="設定の保存">
              <div className="settings-column settings-footer-content justify-content-end">
                <button
                  className="btn-solid theme-primary"
                  disabled={busy || loginPending || !dirty}
                  onClick={() => void save()}
                >
                  {busy ? "処理中…" : "設定を保存"}
                </button>
              </div>
            </footer>
          )}
        </div>
      </div>
    </section>
  );
}
