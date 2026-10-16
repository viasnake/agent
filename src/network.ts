import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { AgentError } from "./types.js";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  // Only globally routed IPv6 unicast; reject transition, documentation, and mapped addresses.
  if (family === 6)
    return (
      /^[23][0-9a-f]{3}:/i.test(address) &&
      !/^2001:(?:0:|db8:|0?2:)/i.test(address) &&
      !/^2002:/i.test(address)
    );
  return false;
}
export interface PublicFetchResult {
  url: string;
  body: Buffer;
  contentType: string;
  mediaType: string;
  charset?: string;
  lastModified: string | null;
  retrievedAt: string;
}

export interface PublicFetchDependencies {
  request?: (
    url: URL,
    init: Parameters<typeof undiciFetch>[1],
  ) => ReturnType<typeof undiciFetch>;
}

function parseContentType(header: string): {
  mediaType: string;
  charset?: string;
} {
  const [type = "", ...parameters] = header.split(";");
  const mediaType = type.trim().toLowerCase();
  let charset: string | undefined;
  for (const parameter of parameters) {
    const match = /^\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(
      parameter,
    );
    if (match) {
      charset = (match[1] ?? match[2] ?? match[3])?.trim();
      break;
    }
  }
  return { mediaType, charset };
}

export async function fetchPublic(
  url: URL,
  signal: AbortSignal,
  allowedHosts: string[],
  maxBytes = 1_000_000,
  dependencies: PublicFetchDependencies = {},
): Promise<PublicFetchResult> {
  const request = dependencies.request ?? undiciFetch;
  const dispatcher = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        lookup(hostname, { all: true }).then(
          (addresses) => {
            if (
              !addresses.length ||
              addresses.some((a) => !publicAddress(a.address))
            ) {
              callback(new Error("Non-public network destination"), "", 4);
              return;
            }
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
          },
          (error) => callback(error, "", 4),
        );
      },
    },
  });
  try {
    let current = url;
    for (let redirect = 0; redirect <= 5; redirect++) {
      signal.throwIfAborted();
      if (
        current.protocol !== "https:" ||
        current.username ||
        current.password ||
        (current.port && current.port !== "443") ||
        !allowedHosts.includes(current.hostname) ||
        current.hash
      )
        throw new AgentError(
          "URL_DENIED",
          "URL must use HTTPS on an explicitly allowed host without credentials or fragment",
        );
      if (isIP(current.hostname) && !publicAddress(current.hostname))
        throw new AgentError(
          "URL_DENIED",
          "Private addresses cannot be fetched",
        );
      const response = await request(current, {
        dispatcher,
        signal,
        redirect: "manual",
        headers: {
          "User-Agent": "local-agent/0.1",
          Accept: "text/plain,text/html,application/json",
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location)
          throw new AgentError("FETCH", "Redirect has no location");
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AgentError("FETCH", `HTTP ${response.status}`);
      }
      const type = response.headers.get("content-type") ?? "";
      const parsedType = parseContentType(type);
      if (!(
        parsedType.mediaType.startsWith("text/") ||
        /^application\/(?:json|xml|xhtml\+xml)$/.test(parsedType.mediaType)
      )) {
        await response.body?.cancel();
        throw new AgentError("FETCH", "Only text documents are supported");
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (!response.body) throw new AgentError("FETCH", "Empty response body");
      const reader = response.body.getReader();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > maxBytes)
            throw new AgentError("FETCH_SIZE", "Source exceeds the byte limit");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      return {
        url: current.href,
        body: Buffer.concat(chunks, bytes),
        contentType: type,
        mediaType: parsedType.mediaType,
        charset: parsedType.charset,
        lastModified: response.headers.get("last-modified"),
        retrievedAt: new Date().toISOString(),
      };
    }
    throw new AgentError("FETCH", "Too many redirects");
  } finally {
    await dispatcher.close();
  }
}
export function endpointFetch(
  endpoint: string,
  signal: AbortSignal,
  onResponse?: (status: number, retryAfter: string | null) => void,
): typeof globalThis.fetch {
  const base = new URL(endpoint);
  return async (input, init) => {
    signal.throwIfAborted();
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== base.origin ||
      !(
        url.pathname === base.pathname ||
        url.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/")
      ) ||
      url.username ||
      url.password
    )
      throw new AgentError(
        "ENDPOINT_DENIED",
        "Provider attempted an unconfigured destination",
      );
    const response = await fetch(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
    });
    onResponse?.(response.status, response.headers.get("retry-after"));
    return response;
  };
}
