import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { RemoteOptions } from "../src/mcp.js";
export async function remoteFixture() {
  const origin = "https://fixture.example";
  let refreshes = 0,
    calls = 0,
    authorizations = 0;
  let access = "",
    refresh = "";
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const clients = new Map<string, { redirect_uris: string[] }>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json({
        resource: `${origin}/oauth`,
        authorization_servers: [origin],
        scopes_supported: ["tools"],
      });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (url.pathname === "/register") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const info = JSON.parse(body),
        id = randomUUID();
      clients.set(id, info);
      json({ ...info, client_id: id }, 201);
      return;
    }
    if (url.pathname === "/authorize") {
      const client = clients.get(url.searchParams.get("client_id") ?? ""),
        redirect = url.searchParams.get("redirect_uri") ?? "";
      if (
        !client?.redirect_uris.includes(redirect) ||
        url.searchParams.get("code_challenge_method") !== "S256"
      ) {
        json({ error: "invalid_request" }, 400);
        return;
      }
      const code = randomUUID();
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge")!,
        redirect,
      });
      authorizations++;
      const callback = new URL(redirect);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      res.writeHead(302, { location: callback.toString() });
      res.end();
      return;
    }
    if (url.pathname === "/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const p = new URLSearchParams(body);
      if (p.get("grant_type") === "authorization_code") {
        const code = p.get("code") ?? "",
          entry = codes.get(code);
        codes.delete(code);
        const challenge = createHash("sha256")
          .update(p.get("code_verifier") ?? "")
          .digest("base64url");
        if (
          !entry ||
          entry.challenge !== challenge ||
          entry.redirect !== p.get("redirect_uri")
        ) {
          json({ error: "invalid_grant" }, 400);
          return;
        }
      } else if (
        p.get("grant_type") === "refresh_token" &&
        p.get("refresh_token") === refresh
      ) {
        refreshes++;
      } else {
        json({ error: "invalid_grant" }, 400);
        return;
      }
      access = `access-${randomUUID()}`;
      refresh = `refresh-${randomUUID()}`;
      json({
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 1,
      });
      return;
    }
    if (["/public", "/bearer", "/oauth"].includes(url.pathname)) {
      const required =
        url.pathname === "/bearer"
          ? "fixture-bearer"
          : url.pathname === "/oauth"
            ? access
            : undefined;
      if (
        required !== undefined &&
        (!required || req.headers.authorization !== `Bearer ${required}`)
      ) {
        res.setHeader(
          "www-authenticate",
          `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/oauth"`,
        );
        json({ error: "unauthorized" }, 401);
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      const mcp = new McpServer({ name: "remote-fixture", version: "1.0.0" });
      mcp.registerTool(
        "greet",
        {
          description: `Remote greeting ${required ?? "public"}`,
          inputSchema: {
            name: z.string().describe(`Hint ${required ?? "public"}`),
          },
        },
        async ({ name }) => {
          calls++;
          return {
            content: [
              {
                type: "text",
                text: `Remote hello ${name}; ${required ?? "public"}`,
              },
            ],
          };
        },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    json({ error: "not_found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (u.origin !== origin)
      throw new Error("Fixture cannot access external network");
    return fetch(`${local}${u.pathname}${u.search}`, {
      ...init,
      redirect: "manual",
    });
  };
  const options: RemoteOptions = {
    fetch: () => fetcher,
    validateAuthorizationUrl: async (u) => {
      if (u.origin !== origin) throw new Error("Unexpected authorization URL");
    },
  };
  return {
    origin,
    local,
    options,
    fetch: fetcher,
    counts: () => ({ refreshes, calls, authorizations }),
    secrets: () => [access, refresh],
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
