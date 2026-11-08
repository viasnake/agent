import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  auth,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { ToolInfo } from "./execution/protocol.js";
import type { McpConfig } from "./settings.js";
import { connectionIdentity, SettingsStore } from "./settings.js";
import { remoteFetch, remoteUrl, validateRemote } from "./remote-http.js";
import { AppError } from "./security.js";

export type McpStatus = {
  state: "ready" | "error" | "disabled" | "untested";
  message: string;
  tools: ToolInfo[];
};
export type RemoteOptions = {
  network?: Parameters<typeof remoteFetch>[1];
  fetch?: (server: McpConfig) => typeof fetch;
  validateAuthorizationUrl?: (url: URL, server: McpConfig) => Promise<void>;
};
type Login = {
  server: McpConfig;
  provider: OAuthClientProvider;
  expires: number;
  binding: string;
  origin: string;
  url?: string;
};
export class RemoteMcp {
  private pending = new Map<string, Login>();
  constructor(
    private store: SettingsStore,
    private options: RemoteOptions = {},
  ) {}
  private allowedHosts(server: McpConfig) {
    // Registering this target permits its private/VPN address, not other hosts
    // suggested by discovery. Loopback and metadata restrictions still apply.
    return [
      ...server.privateHosts,
      new URL(server.url).hostname.replace(/^\[|\]$/g, ""),
    ];
  }
  private fetch(server: McpConfig) {
    const url = remoteUrl(server.url, server.auth === "none");
    return (
      this.options.fetch?.(server) ??
      remoteFetch(this.allowedHosts(server), {
        ...this.options.network,
        httpOrigin: url.protocol === "http:" ? url.origin : undefined,
      })
    );
  }
  private provider(
    server: McpConfig,
    redirectUrl: string,
    login?: { state: string; redirect: (url: string) => void },
  ): OAuthClientProvider {
    const identity = connectionIdentity(server);
    let verifier = "";
    const oauth = structuredClone(server.oauth ?? {});
    const persist = async (
      update: (value: NonNullable<McpConfig["oauth"]>) => void,
    ) => {
      update(oauth);
      try {
        await this.store.oauth(server.id, identity, update);
      } catch (error) {
        if (login || !(error instanceof AppError) || error.statusCode !== 409)
          throw error;
      }
    };
    const current = () => {
      const s = this.store.snapshot().mcp.find((s) => s.id === server.id);
      if (login && (!s || connectionIdentity(s) !== identity))
        throw new AppError(409, "MCP 設定が変更されています");
      return login ? s! : { ...server, oauth };
    };
    return {
      redirectUrl,
      clientMetadata: {
        client_name: "Pi Agent",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: server.clientSecret
          ? "client_secret_post"
          : "none",
      },
      state: () => {
        if (!login) throw new UnauthorizedError();
        return login.state;
      },
      clientInformation: () =>
        current().oauth?.client ??
        (server.clientId
          ? {
              client_id: server.clientId,
              client_secret: server.clientSecret || undefined,
            }
          : undefined),
      saveClientInformation: async (client) => {
        await persist((value) => {
          value.client = client;
        });
      },
      tokens: () => current().oauth?.tokens,
      saveTokens: async (tokens) => {
        await persist((value) => {
          value.tokens = tokens;
          value.expiresAt = tokens.expires_in
            ? Date.now() + tokens.expires_in * 1000
            : undefined;
        });
      },
      redirectToAuthorization: async (url) => {
        if (!login)
          throw new UnauthorizedError("Web settings authorization required");
        remoteUrl(url);
        if (this.options.validateAuthorizationUrl)
          await this.options.validateAuthorizationUrl(url, server);
        else await validateRemote(url, this.allowedHosts(server));
        login.redirect(url.toString());
      },
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      codeVerifier: () => {
        if (!verifier) throw new UnauthorizedError();
        return verifier;
      },
      invalidateCredentials: async (scope) => {
        await persist((value) => {
          if (scope === "all" || scope === "client") delete value.client;
          if (scope === "all" || scope === "tokens") delete value.tokens;
        });
        if (scope === "all" || scope === "verifier") verifier = "";
      },
    };
  }
  async begin(
    server: McpConfig,
    origin: string,
    binding: string,
  ): Promise<string> {
    if (server.transport !== "http" || server.auth !== "oauth")
      throw new AppError(400, "OAuth 対応の HTTP MCP を選択してください");
    for (const [state, login] of this.pending)
      if (login.expires < Date.now()) this.pending.delete(state);
    if (this.pending.size >= 24)
      throw new AppError(429, "認証を完了してからやり直してください");
    this.cancel(server.id);
    server = await this.store.beginOAuth(server.id);
    const state = randomBytes(32).toString("hex");
    const login: Login = {
      server,
      provider: undefined!,
      expires: Date.now() + 10 * 60 * 1000,
      binding,
      origin,
    };
    login.provider = this.provider(server, `${origin}/oauth/callback`, {
      state,
      redirect: (url) => {
        login.url = url;
      },
    });
    this.pending.set(state, login);
    try {
      const result = await auth(login.provider, {
        serverUrl: server.url,
        fetchFn: this.fetch(server),
      });
      if (result !== "REDIRECT" || !login.url)
        throw new Error("Authorization redirect missing");
      return login.url;
    } catch {
      this.pending.delete(state);
      throw new AppError(
        400,
        "OAuth を開始できません。認証サーバー・クライアント登録・localhost コールバックの許可を確認してください",
      );
    }
  }
  async finish(
    state: string,
    code: string,
    binding: string,
    host: string,
  ): Promise<void> {
    const login = this.pending.get(state);
    if (
      !login ||
      login.expires < Date.now() ||
      login.binding !== binding ||
      new URL(login.origin).host !== host
    )
      throw new AppError(
        400,
        "認証の state・ブラウザー・有効期限を確認できません。認証をやり直してください",
      );
    this.pending.delete(state);
    try {
      const result = await auth(login.provider, {
        serverUrl: login.server.url,
        authorizationCode: code,
        fetchFn: this.fetch(login.server),
      });
      if (result !== "AUTHORIZED") throw new Error();
    } catch {
      throw new AppError(
        400,
        "OAuth 認証に失敗しました。localhost コールバックの許可とクライアント設定を確認してください",
      );
    }
  }
  cancel(id: string) {
    for (const [state, login] of this.pending)
      if (login.server.id === id) this.pending.delete(state);
  }
  async use<T>(
    server: McpConfig,
    origin: string,
    operation: (client: Client, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const latest = this.store.snapshot().mcp.find((s) => s.id === server.id);
    if (latest && connectionIdentity(latest) === connectionIdentity(server))
      server = latest;
    if (server.auth === "oauth" && !server.oauth?.tokens)
      throw new UnauthorizedError("Web authorization required");
    const bounded = AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(30000),
    ]);
    const fetcher = this.fetch(server);
    const boundedFetch: typeof fetch = (input, init) =>
      fetcher(input, {
        ...init,
        signal: AbortSignal.any([
          bounded,
          init?.signal ?? new AbortController().signal,
        ]),
      });
    const provider =
      server.auth === "oauth"
        ? this.provider(server, `${origin}/oauth/callback`)
        : undefined;
    const client = new Client({ name: "pi-agent", version: "0.2.0" });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      fetch: boundedFetch,
      authProvider: provider,
      requestInit:
        server.auth === "bearer"
          ? { headers: { Authorization: `Bearer ${server.bearer ?? ""}` } }
          : undefined,
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    });
    const close = () => {
      void transport.close().catch(() => {});
    };
    bounded.addEventListener("abort", close, { once: true });
    try {
      if (
        provider &&
        server.oauth?.expiresAt &&
        server.oauth.expiresAt <= Date.now() + 30000
      ) {
        const result = await auth(provider, {
          serverUrl: server.url,
          fetchFn: boundedFetch,
        });
        if (result !== "AUTHORIZED") throw new UnauthorizedError();
      }
      await client.connect(transport, { timeout: 30000, signal: bounded });
      return await operation(client, bounded);
    } finally {
      bounded.removeEventListener("abort", close);
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }
  async list(server: McpConfig, origin: string): Promise<ToolInfo[]> {
    return this.use(server, origin, async (client, signal) => {
      const tools: ToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          signal,
          timeout: 30000,
        });
        for (const tool of page.tools)
          tools.push({
            name: tool.name,
            description: tool.description ?? "",
            parameters: tool.inputSchema,
          });
        cursor = page.nextCursor;
        if (tools.length > 100 || (cursor && page.tools.length === 0))
          throw new Error("Tool list limit");
      } while (cursor);
      return tools;
    });
  }
}
