import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:https";
import type { AddressInfo } from "node:net";
import { BlockList } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  remoteFetch,
  resolveRemote,
  remoteUrl,
  allowedAddress,
} from "../src/remote-http.js";
test("HTTPS fetch pins each TLS lookup, preserves streaming, refuses redirects and bounds responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-tls-"));
  const key = join(root, "key.pem"),
    cert = join(root, "cert.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=fixture.example",
      "-addext",
      "subjectAltName=DNS:fixture.example",
    ],
    { stdio: "ignore" },
  );
  assert.equal(generated.status, 0);
  const ca = await readFile(cert);
  let redirected = 0,
    resolutions = 0,
    lookups = 0;
  const server = createServer(
    { key: await readFile(key), cert: ca },
    (req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "https://169.254.169.254/latest" });
        res.end();
        return;
      }
      if (req.url === "/large") {
        res.writeHead(200);
        res.end("x".repeat(3 * 1024 * 1024));
        return;
      }
      if (req.url === "/latest") redirected++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => res.end("data: second\n\n"), 10);
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const fetcher = remoteFetch([], {
    resolve: async (url) => {
      assert.equal(url.hostname, "fixture.example");
      resolutions++;
      return { address: "127.0.0.1", family: 4 };
    },
    request: ((url, options, callback) => {
      const lookup = options.lookup!;
      options.lookup = (host, opts, cb) => {
        lookups++;
        lookup(host, opts, cb);
      };
      return request(url, { ...options, ca }, callback);
    }) as typeof request,
  });
  try {
    const unresolved = remoteFetch([], {
      resolve: () => new Promise(() => {}),
    });
    await assert.rejects(
      unresolved(`https://fixture.example:${port}/stream`, {
        signal: AbortSignal.timeout(20),
      }),
      /timeout/i,
    );
    const response = await fetcher(`https://fixture.example:${port}/stream`);
    assert.match(await response.text(), /first[\s\S]*second/);
    assert.equal(lookups, 1);
    assert.equal(resolutions, 1);
    await assert.rejects(
      fetcher(`https://fixture.example:${port}/redirect`),
      /リダイレクト/,
    );
    assert.equal(redirected, 0);
    assert.equal(lookups, 2);
    const large = await fetcher(`https://fixture.example:${port}/large`);
    await assert.rejects(large.text());
    await assert.rejects(
      fetcher(`https://fixture.example:${port}/stream`, {
        headers: { Host: "169.254.169.254" },
      }),
      /Host/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true });
  }
});
test("protected public company ranges need host grants; metadata grants never override rejection", async () => {
  const protectedRanges = new BlockList();
  protectedRanges.addSubnet("8.8.8.0", 24, "ipv4");
  const dns = async () => [{ address: "8.8.8.8", family: 4 }],
    url = remoteUrl("https://company.example/mcp");
  await assert.rejects(resolveRemote(url, [], dns, protectedRanges));
  assert.equal(
    (await resolveRemote(url, ["company.example"], dns, protectedRanges))
      .address,
    "8.8.8.8",
  );
  for (const address of ["100.100.100.200", "168.63.129.16", "fd00:ec2::254"])
    assert.equal(allowedAddress(address, true), false);
  let calls = 0;
  const rebinding = async () => [
    { address: ++calls === 1 ? "8.8.8.8" : "169.254.169.254", family: 4 },
  ];
  assert.equal((await resolveRemote(url, [], rebinding)).address, "8.8.8.8");
  await assert.rejects(resolveRemote(url, [], rebinding));
  assert.equal(calls, 2);
});
