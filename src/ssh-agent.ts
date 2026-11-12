import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  lstat,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, createConnection, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "./security.js";

const exec = promisify(execFile);
const SSH2_AGENTC_REQUEST_IDENTITIES = 11;
const SSH2_AGENTC_SIGN_REQUEST = 13;
const cleanEnv = {
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  SSH_ASKPASS_REQUIRE: "never",
};

export async function generateSshKey(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-key-"));
  try {
    const path = join(dir, "key");
    await exec(
      "/usr/bin/ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", path],
      {
        env: cleanEnv,
        timeout: 5000,
        maxBuffer: 32768,
      },
    );
    return await readFile(path, "utf8");
  } catch {
    throw new AppError(
      503,
      "SSH 鍵を生成できません。SSH の導入状態を確認してください",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function sshPublicKey(privateKey: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-key-"));
  try {
    const path = join(dir, "key");
    await writeFile(path, privateKey.trim() + "\n", { mode: 0o600 });
    const result = await exec(
      "/usr/bin/ssh-keygen",
      ["-y", "-P", "", "-f", path],
      {
        env: cleanEnv,
        timeout: 5000,
        maxBuffer: 32768,
      },
    );
    return result.stdout.trim();
  } catch {
    throw new AppError(
      400,
      "SSH 鍵を読み込めません。パスフレーズなしの秘密鍵を指定してください",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Each command gets a disposable signer. No private key or control-side socket
// crosses the UID boundary; the work socket permits only listing and signing.
export async function openSshAgent(
  keys: string[],
  workUid: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const dir = await mkdtemp("/tmp/agent-ssh-");
  const privateDir = join(dir, "private"),
    socket = join(dir, "socket");
  await mkdir(privateDir, { mode: 0o700 });
  const privateSocket = join(privateDir, "agent");
  const child = spawn(
    "/usr/bin/ssh-agent",
    ["-D", "-a", privateSocket, "-P", ""],
    {
      env: cleanEnv,
      stdio: "ignore",
    },
  );
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once("error", () => {
      exited = true;
      resolve();
    });
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    if (sockets.size >= 32) {
      client.destroy();
      return;
    }
    const upstream = createConnection(privateSocket);
    sockets.add(client);
    sockets.add(upstream);
    let buffer = Buffer.alloc(0),
      requests = 0;
    const destroy = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", destroy);
    upstream.on("error", destroy);
    client.on("close", destroy);
    upstream.on("close", destroy);
    client.setTimeout(10000, destroy);
    upstream.pipe(client);
    client.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 131072) {
        destroy();
        return;
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (!length || length > 131068) {
          destroy();
          return;
        }
        if (buffer.length < length + 4) return;
        const packet = buffer.subarray(0, length + 4);
        buffer = buffer.subarray(length + 4);
        if (++requests > 64) {
          destroy();
          return;
        }
        if (
          packet[4] !== SSH2_AGENTC_REQUEST_IDENTITIES &&
          packet[4] !== SSH2_AGENTC_SIGN_REQUEST
        ) {
          client.write(Buffer.from([0, 0, 0, 1, 5]));
          continue;
        }
        if (!upstream.write(packet)) {
          destroy();
          return;
        }
      }
    });
  });
  let closing: Promise<void> | undefined;
  const abort = () => {
    void close().catch(() => {});
  };
  function close(): Promise<void> {
    return (closing ??= (async () => {
      signal?.removeEventListener("abort", abort);
      for (const socket of sockets) socket.destroy();
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!exited) child.kill("SIGKILL");
      await exit;
      await rm(dir, { recursive: true, force: true });
    })());
  }
  try {
    signal?.throwIfAborted();
    const deadline = Date.now() + 5000;
    while (!(await lstat(privateSocket).catch(() => null))?.isSocket()) {
      signal?.throwIfAborted();
      if (exited || Date.now() >= deadline)
        throw new Error("Agent did not start");
      await delay(10);
    }
    for (const [index, key] of keys.entries()) {
      signal?.throwIfAborted();
      const path = join(privateDir, `key-${index}`);
      await writeFile(path, key.trim() + "\n", { mode: 0o600 });
      await exec("/usr/bin/ssh-add", [path], {
        env: { ...cleanEnv, SSH_AUTH_SOCK: privateSocket },
        timeout: 5000,
        maxBuffer: 32768,
        signal,
      });
      await rm(path);
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    server.on("error", () => {
      void close().catch(() => {});
    });
    await chmod(socket, 0o600);
    if (workUid !== process.getuid?.()) {
      // The control-owned directory remains non-writable by work. Do not widen
      // access to other local users or rely on an obscured socket pathname.
      await exec("/usr/bin/setfacl", ["-m", `u:${workUid}:x`, dir], {
        env: cleanEnv,
        timeout: 5000,
        signal,
      });
      await exec("/usr/bin/setfacl", ["-m", `u:${workUid}:rw`, socket], {
        env: cleanEnv,
        timeout: 5000,
        signal,
      });
    }
    signal?.addEventListener("abort", abort, { once: true });
    signal?.throwIfAborted();
    return { socket, close };
  } catch {
    await close();
    throw new AppError(
      503,
      "SSH 鍵を利用できません。SSH と ACL の導入状態を確認してください",
    );
  }
}
