import { randomUUID } from "node:crypto";
import type { OAuthAuth } from "@earendil-works/pi-ai";
import { modelProvider } from "./model-providers.js";
import { SettingsStore } from "./settings.js";
import { AppError } from "./security.js";

export type ModelLogin = {
  id: string;
  modelId: string;
  provider: string;
  userCode?: string;
  state: "waiting" | "exchanging" | "complete" | "error";
  url?: string;
  message: string;
};
type Pending = {
  view: ModelLogin;
  owner: string;
  abort: AbortController;
  timer: NodeJS.Timeout;
  submit?: (url: string) => void;
  done: Promise<void>;
};

// Adapt Pi's public interactive OAuth API to the local browser session. The SDK
// owns device polling or PKCE, code exchange and the loopback callback listener.
export class ModelAuth {
  private pending?: Pending;
  constructor(
    private settings: SettingsStore,
    private oauth?: OAuthAuth,
  ) {}
  async begin(modelId: string, owner: string): Promise<ModelLogin> {
    if (
      this.pending &&
      !["complete", "error"].includes(this.pending.view.state)
    )
      throw new AppError(409, "進行中の認証を完了または中止してください");
    const model = this.settings.snapshot().models.find((m) => m.id === modelId);
    if (!model || model.auth !== "oauth")
      throw new AppError(400, "OAuth 接続を保存してください");
    const copilot = model.provider === "github-copilot";
    const oauth = this.oauth ?? modelProvider(model).auth.oauth;
    if (!oauth) throw new AppError(400, "OAuth に対応していません");
    // Only ChatGPT starts a callback listener; Device Flow never binds a port.
    if (
      !copilot &&
      process.env.PI_OAUTH_CALLBACK_HOST &&
      process.env.PI_OAUTH_CALLBACK_HOST !== "127.0.0.1"
    )
      throw new AppError(
        400,
        "PI_OAUTH_CALLBACK_HOST は 127.0.0.1 にしてください",
      );
    if (this.pending) clearTimeout(this.pending.timer);
    const abort = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const pending: Pending = {
      view: {
        id: randomUUID(),
        modelId,
        provider: model.provider,
        state: "waiting",
        message: "認証の準備中",
      },
      owner,
      abort,
      timer: setTimeout(() => abort.abort(), 10 * 60 * 1000),
      done: Promise.resolve(),
    };
    pending.timer.unref();
    this.pending = pending;
    pending.done = oauth
      .login(
        {
          signal: abort.signal,
          notify: (event) => {
            abort.signal.throwIfAborted();
            if (copilot && event.type === "device_code") {
              const url = new URL(event.verificationUri);
              if (
                url.origin !== "https://github.com" ||
                url.username ||
                url.password
              )
                throw new Error("Unexpected authorization origin");
              pending.view.url = url.href;
              pending.view.userCode = event.userCode;
              pending.view.message =
                "GitHub でコードを入力し、認証を完了してください";
              ready();
            } else if (copilot && event.type === "progress") {
              pending.view.message = "利用可能なモデルを確認中";
            } else if (!copilot && event.type === "auth_url") {
              const url = new URL(event.url);
              if (url.origin !== "https://auth.openai.com")
                throw new Error("Unexpected authorization origin");
              pending.view.url = url.href;
              pending.view.message =
                "別タブで ChatGPT の認証を完了してください";
              ready();
            }
          },
          prompt: async (prompt) => {
            abort.signal.throwIfAborted();
            if (copilot && prompt.type === "text") return "";
            if (copilot || prompt.type !== "manual_code")
              throw new Error("Unsupported login prompt");
            const signal = AbortSignal.any([
              abort.signal,
              ...(prompt.signal ? [prompt.signal] : []),
            ]);
            return new Promise<string>((resolve, reject) => {
              const cancel = () => {
                pending.submit = undefined;
                reject(new Error("Login cancelled"));
              };
              if (signal.aborted) return cancel();
              signal.addEventListener("abort", cancel, { once: true });
              pending.submit = (url) => {
                pending.submit = undefined;
                signal.removeEventListener("abort", cancel);
                resolve(url);
              };
            });
          },
        },
        {
          getDeviceId: () => this.settings.snapshot().hostId,
          agentName: "viasnake/agent",
        },
      )
      .then(async (credential) => {
        abort.signal.throwIfAborted();
        await this.settings.setModelOAuth(
          modelId,
          model.authVersion,
          credential,
        );
        pending.view.state = "complete";
        pending.view.message = "認証しました。次の実行開始時に反映します。";
      })
      .catch((error: unknown) => {
        pending.view.state = "error";
        pending.view.message = abort.signal.aborted
          ? "認証を中止しました（有効期限は10分）"
          : copilot
            ? error instanceof Error &&
              /Device flow timed out|expired_token/.test(error.message)
              ? "認証の有効期限が切れました。やり直してください。"
              : "GitHub 認証に失敗しました。認可と接続を確認し、やり直してください。"
            : "認証できません。認可・コールバック URL・VM 内のポート1455の使用状況を確認し、やり直してください。";
      })
      .finally(() => {
        clearTimeout(pending.timer);
        pending.submit = undefined;
        delete pending.view.url;
        delete pending.view.userCode;
        ready();
      });
    await started;
    return { ...pending.view };
  }
  private owned(id: string, owner: string): Pending {
    if (
      !this.pending ||
      this.pending.view.id !== id ||
      this.pending.owner !== owner
    )
      throw new AppError(
        404,
        "認証操作がありません。開始したブラウザーで操作してください",
      );
    return this.pending;
  }
  current(owner: string): ModelLogin | null {
    return this.pending?.owner === owner ? { ...this.pending.view } : null;
  }
  status(id: string, owner: string): ModelLogin {
    return { ...this.owned(id, owner).view };
  }
  submit(id: string, owner: string, url: string): ModelLogin {
    const pending = this.owned(id, owner);
    if (!pending.submit || pending.view.state !== "waiting")
      throw new AppError(409, "認証 URL を送信できません。やり直してください");
    pending.view.state = "exchanging";
    pending.view.message = "認証を確認中";
    pending.submit(url);
    return { ...pending.view };
  }
  async cancel(id: string, owner: string): Promise<ModelLogin> {
    const pending = this.owned(id, owner);
    pending.abort.abort();
    await pending.done;
    return { ...pending.view };
  }
  async disconnect(modelId: string): Promise<void> {
    if (this.pending?.view.modelId === modelId) {
      const pending = this.pending;
      pending.abort.abort();
      await pending.done;
      if (this.pending === pending) this.pending = undefined;
    }
    const model = this.settings.snapshot().models.find((m) => m.id === modelId);
    if (!model) throw new AppError(404, "モデルがありません");
    await this.settings.setModelOAuth(modelId, model.authVersion);
  }
  async close(): Promise<void> {
    this.pending?.abort.abort();
    await this.pending?.done;
  }
}
