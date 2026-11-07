import { readFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { AppError } from "./security.js";

const forbidden = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  forbidden.addSubnet(ip, prefix, "ipv4");
forbidden.addAddress("100.100.100.200", "ipv4");
forbidden.addAddress("168.63.129.16", "ipv4");
forbidden.addAddress("fd00:ec2::254", "ipv6");
const privateAddresses = new BlockList();
for (const [ip, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
] as const)
  privateAddresses.addSubnet(ip, prefix, "ipv4");
privateAddresses.addSubnet("fc00::", 7, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [ip, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const)
  forbidden.addSubnet(ip, prefix, "ipv6");
export function allowedAddress(address: string, allowPrivate = false): boolean {
  const version = isIP(address);
  if (!version) return false;
  const family = version === 4 ? "ipv4" : "ipv6";
  if (forbidden.check(address, family)) return false;
  if (privateAddresses.check(address, family)) return allowPrivate;
  return version === 4 || globalV6.check(address, "ipv6");
}
export function remoteUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new AppError(
      400,
      "MCP・認証の接続先には資格情報を含まない HTTPS URL が必要です",
    );
  return url;
}
export type ResolveHost = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;
export async function resolveRemote(
  url: URL,
  privateHosts: string[],
  resolveHost: ResolveHost = (hostname) =>
    lookup(hostname, { all: true, verbatim: true }),
  protectedAddresses?: BlockList,
) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolveHost(hostname);
  const allowPrivate = privateHosts.some(
    (host) => host.toLowerCase() === hostname,
  );
  if (
    !addresses.length ||
    addresses.some(
      (item) =>
        !allowedAddress(item.address, allowPrivate) ||
        (!allowPrivate &&
          protectedAddresses?.check(
            item.address,
            item.family === 4 ? "ipv4" : "ipv6",
          )),
    )
  )
    throw new AppError(
      403,
      "MCP・認証の接続先アドレスが許可されていません。社内・VPN のホストは明示的な許可が必要です",
    );
  return addresses[0]!;
}
export async function protectedNetworks(): Promise<BlockList> {
  const source = (
    await readFile("/etc/agent/protected-cidrs.nft", "utf8")
  ).replace(/#.*$/gm, "");
  const match = source.match(
    /^\s*define\s+protected_cidrs\s*=\s*\{([^}]+)\}\s*$/,
  );
  if (!match) throw new Error("Invalid protected network policy");
  const list = new BlockList();
  for (const item of match[1]!.split(",")) {
    const [address, prefix] = item.trim().split("/");
    const family = isIP(address!);
    if (!family || !/^\d+$/.test(prefix ?? ""))
      throw new Error("Invalid protected network range");
    list.addSubnet(address!, Number(prefix), family === 4 ? "ipv4" : "ipv6");
  }
  return list;
}
export async function validateRemote(url: URL, privateHosts: string[]) {
  return resolveRemote(url, privateHosts, undefined, await protectedNetworks());
}
// Resolve once per connection and pin the TLS socket to the checked address. SDK
// discovery, registration, token exchange and transport all use this same fetch.
export function remoteFetch(
  privateHosts: string[],
  dependencies: {
    resolve?: typeof validateRemote;
    request?: typeof request;
  } = {},
): typeof fetch {
  return async (input, init) => {
    const source = input instanceof Request ? input : undefined;
    const url = remoteUrl(source?.url ?? String(input));
    const signal = AbortSignal.any([
      init?.signal ?? source?.signal ?? new AbortController().signal,
      AbortSignal.timeout(30000),
    ]);
    signal.throwIfAborted();
    const target = await new Promise<{ address: string; family: number }>(
      (resolve, reject) => {
        const aborted = () => reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
        void (dependencies.resolve ?? validateRemote)(url, privateHosts)
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", aborted));
      },
    );
    signal.throwIfAborted();
    const headers = new Headers(init?.headers ?? source?.headers);
    if (headers.has("host"))
      throw new AppError(400, "Host の上書きはできません");
    const method = init?.method ?? source?.method ?? "GET";
    const body =
      init?.body ?? (source ? await source.arrayBuffer() : undefined);
    if (
      body &&
      typeof body !== "string" &&
      !(body instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(body) &&
      !(body instanceof URLSearchParams)
    )
      throw new Error("Unsupported HTTP body");
    return new Promise<Response>((resolve, reject) => {
      const req = (dependencies.request ?? request)(
        url,
        {
          method,
          agent: false,
          headers: Object.fromEntries(headers),
          signal,
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [target]);
            else callback(null, target.address, target.family);
          },
        },
        (response) => {
          const status = response.statusCode ?? 500;
          if (status >= 300 && status < 400) {
            response.destroy();
            reject(
              new AppError(
                403,
                "MCP・認証の HTTP リダイレクトは許可されていません。最終 URL を設定してください",
              ),
            );
            return;
          }
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers))
            if (value)
              responseHeaders.set(
                key,
                Array.isArray(value) ? value.join(", ") : value,
              );
          let bytes = 0;
          response.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 2 * 1024 * 1024)
              response.destroy(new Error("MCP response limit"));
          });
          if ([204, 205, 304].includes(status)) {
            response.resume();
            resolve(new Response(null, { status, headers: responseHeaders }));
            return;
          }
          resolve(
            new Response(
              Readable.toWeb(response) as ReadableStream<Uint8Array>,
              { status, headers: responseHeaders },
            ),
          );
        },
      );
      req.on("error", reject);
      req.end(
        body instanceof URLSearchParams
          ? body.toString()
          : body instanceof ArrayBuffer
            ? Buffer.from(body)
            : body,
      );
    });
  };
}
