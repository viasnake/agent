import { type AuthProvider } from "@earendil-works/pi-mcp";
import {
  McpOAuthProvider,
  OAuthCallbackServer,
  adaptOAuthProvider,
  authorizeMcp,
  type McpOAuthState,
} from "@earendil-works/pi-mcp/oauth";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { Config, Paths } from "./config.js";
import { AgentError } from "./types.js";
import { atomicWrite, privateDirectory } from "./util.js";

type Server = Config["mcp"][string];
export function serverFetch(
  server: Server,
  signal: AbortSignal,
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  const mutations = new Set(
    Object.entries(server.tools)
      .filter(([, permission]) => !permission.readOnly)
      .map(([name]) => name),
  );
  return async (input, init) => {
    signal.throwIfAborted();
    const url = new URL(String(input));
    if (
      !server.allowedOrigins.includes(url.origin) ||
      url.username ||
      url.password ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      throw new AgentError(
        "MCP_DESTINATION",
        "MCP/OAuth attempted a destination outside allowedOrigins",
      );
    let mutating = false;
    if (init?.method === "POST" && typeof init.body === "string") {
      try {
        const request = JSON.parse(init.body);
        mutating =
          request?.method === "tools/call" &&
          mutations.has(request.params?.name);
      } catch {
        /* OAuth form bodies are not JSON-RPC. */
      }
    }
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
    });
    // The SDK otherwise resends a POST after an authentication challenge.
    if (mutating && [401, 403].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      throw new AgentError(
        "MCP_MUTATION_AUTH",
        "Authentication failed after dispatch; automatic mutation retry was blocked. Check the external result before resolving the operation and trying again.",
      );
    }
    return response;
  };
}
async function oauthProvider(
  paths: Paths,
  name: string,
  server: Server,
  redirectUrl: string,
  onRedirect: (url: URL) => void,
): Promise<{ provider: McpOAuthProvider; directory: string }> {
  const directory = join(paths.auth, `mcp-${name}`);
  await privateDirectory(directory);
  const statePath = join(directory, "oauth.json");
  const provider = new McpOAuthProvider({
    serverUrl: server.url!,
    redirectUrl,
    clientMetadata: {
      client_name: "Local Agent",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    store: {
      load: async () => {
        try {
          return JSON.parse(await readFile(statePath, "utf8")) as McpOAuthState;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw error;
        }
      },
      save: (state) => atomicWrite(statePath, JSON.stringify(state)),
    },
    onRedirect: (url) => {
      if (!server.allowedOrigins.includes(url.origin))
        throw new AgentError(
          "MCP_DESTINATION",
          "OAuth authorization origin must be listed in allowedOrigins",
        );
      onRedirect(url);
    },
  });
  return { provider, directory };
}
export async function loginMcp(
  config: Config,
  paths: Paths,
  name: string,
  signal: AbortSignal,
  notify: (url: string) => void,
): Promise<void> {
  const server = config.mcp[name];
  if (!server || server.transport !== "http" || !server.oauth)
    throw new AgentError(
      "MCP_AUTH",
      "Configure an HTTP MCP server with oauth: true first",
    );
  const callback = await OAuthCallbackServer.listen({
    port: 1456,
    timeoutMs: 180000,
  });
  let release: (() => Promise<void>) | undefined;
  const abort = () => {
    void callback.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const { provider, directory } = await oauthProvider(
      paths,
      name,
      server,
      callback.redirectUrl,
      (url) => notify(url.href),
    );
    release = await lockfile.lock(directory, { stale: 30000, retries: 0 });
    const state = await provider.state();
    const pending = callback.waitForCallback(state);
    pending.catch(() => {});
    const result = await authorizeMcp(provider, {
      serverUrl: server.url!,
      fetch: serverFetch(server, signal),
      signal,
    });
    if (result === "REDIRECT") {
      const response = await pending;
      if (response.state !== state)
        throw new AgentError("MCP_AUTH", "OAuth state mismatch");
      const finish = await authorizeMcp(provider, {
        serverUrl: server.url!,
        authorizationCode: response.code,
        iss: response.iss,
        fetch: serverFetch(server, signal),
        signal,
      });
      if (finish !== "AUTHORIZED")
        throw new AgentError("MCP_AUTH", "OAuth did not complete");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await callback.close();
    await release?.();
  }
}
export async function connectionAuth(
  paths: Paths,
  name: string,
  server: Server,
): Promise<AuthProvider | undefined> {
  let auth: AuthProvider | undefined;

  if (server.oauth) {
    const { provider, directory } = await oauthProvider(
      paths,
      name,
      server,
      "http://127.0.0.1:1456/callback",
      () => {
        throw new AgentError("MCP_AUTH", `Run agent mcp login ${name}`);
      },
    );
    const adapted = adaptOAuthProvider(provider);
    auth = {
      token: () => adapted.token(),
      onUnauthorized: async (context) => {
        const release = await lockfile.lock(directory, {
          stale: 30000,
          retries: 0,
        });
        try {
          await adapted.onUnauthorized?.(context);
        } finally {
          await release();
        }
      },
    };
  }
  return auth;
}
