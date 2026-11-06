import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  writeFile,
  chown,
  unlink,
  lstat,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { createServer } from "node:http";

const ids = ["S01", "S02", "S03", "S04", "S05", "W02", "R10", "V09"];
function blocked(reason) {
  console.log(JSON.stringify({ result: "blocked", ids, reason }));
  process.exit(77);
}
if (
  process.env.AGENT_GUEST_TEST !== "1" ||
  process.getuid?.() !== 0 ||
  !existsSync("/etc/agent-data.uuid") ||
  !existsSync("/opt/agent/dist/src/execution/client.js")
)
  blocked(
    "Use explicit opt-in as administrator in a dedicated, provisioned test guest",
  );
if (
  spawnSync("systemctl", ["is-active", "--quiet", "agent.service"]).status === 0
)
  blocked(
    "Stop agent.service explicitly in the dedicated test guest first; this test never stops user jobs",
  );
const command = (file, args, options = {}) => {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout: 30000,
    ...options,
  });
  if (result.status !== 0)
    throw new Error(`Guest prerequisite or check failed: ${file}`);
  return result.stdout.trim();
};
const uid = (user) => Number(command("/usr/bin/id", ["-u", user]));
assert.equal(uid("agent-control"), 980);
assert.equal(uid("agent-work"), 981);
for (const path of [
  "/usr/local/libexec/agent-work",
  "/opt/agent-node/bin/node",
  "/opt/agent/dist/src/execution/worker-main.js",
  "/run/agent-egress.ready",
]) {
  const info = await lstat(path);
  assert.equal(info.uid, 0);
  assert.equal(info.mode & 0o022, 0);
}
command("/usr/sbin/visudo", ["-cf", "/etc/sudoers.d/agent-work"]);
command("/usr/sbin/nft", ["list", "table", "inet", "agent_work"]);
assert.equal(
  command("findmnt", ["-n", "-o", "UUID", "--mountpoint", "/srv/agent-data"]),
  (await readFile("/etc/agent-data.uuid", "utf8")).trim(),
);
assert.notEqual(
  spawnSync("sudo", [
    "-u",
    "agent-control",
    "sudo",
    "-n",
    "-u",
    "root",
    "/usr/bin/true",
  ]).status,
  0,
);
assert.notEqual(
  spawnSync("sudo", [
    "-u",
    "agent-control",
    "sudo",
    "-n",
    "-u",
    "agent-work",
    "/usr/local/libexec/agent-work",
    "unexpected-argument",
  ]).status,
  0,
);
const { WorkerClient } = await import(
  "/opt/agent/dist/src/execution/client.js"
);
const runner = new WorkerClient(),
  id = randomUUID(),
  secret = `/srv/agent-data/control/secrets/guest-test-${id}`,
  probePath = `/run/agent-cgroup-probe-${id}.mjs`,
  unit = `agent-cgroup-probe-${id}`;
const privateServer = createServer((_request, response) =>
  response.end("control fixture"),
);
const previewServer = createServer((_request, response) =>
  response.end(
    "<!doctype html><meta charset=utf-8><title>preview fixture</title><p>preview</p>",
  ),
);
let controller;
try {
  await writeFile(secret, "synthetic-guest-secret", {
    flag: "wx",
    mode: 0o600,
  });
  await chown(secret, 980, Number(command("id", ["-g", "agent-control"])));
  controller = spawn(
    "sudo",
    [
      "-u",
      "agent-control",
      "/opt/agent-node/bin/node",
      "-e",
      "console.log(process.pid);setInterval(()=>{},1000)",
    ],
    {
      env: {
        PATH: "/usr/bin:/bin",
        AGENT_GUEST_SENTINEL: "synthetic-control-environment",
      },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const controlPid = await new Promise((resolve) =>
    controller.stdout.once("data", (chunk) =>
      resolve(Number(String(chunk).trim())),
    ),
  );
  await new Promise((resolve) =>
    privateServer.listen(8080, "127.0.0.1", resolve),
  );
  await new Promise((resolve) =>
    previewServer.listen(3098, "127.0.0.1", resolve),
  );
  await runner.ready();
  const health = await runner.call(id, "health", {});
  assert.equal(health.uid, 981);
  await runner.call(id, "init", {});
  const shell = async (text) => {
    const result = await runner.call(id, "shell", {
      command: text,
      timeout: 15,
      maxBytes: 1048576,
    });
    assert.equal(result.exitCode, 0, "Worker boundary check failed");
    return result;
  };
  await shell(
    `test "$(id -u)" = 981 && ! cat '${secret}' >/dev/null 2>&1 && ! cat /proc/${controlPid}/environ >/dev/null 2>&1 && ! ls /proc/${controlPid}/fd >/dev/null 2>&1 && test -z "\${OPENAI_API_KEY-}\${GH_TOKEN-}\${SSH_AUTH_SOCK-}\${NODE_OPTIONS-}\${LD_PRELOAD-}\${AGENT_GUEST_SENTINEL-}" && ! sudo -n -u root /usr/bin/true >/dev/null 2>&1`,
  );
  await shell(
    "! curl --connect-timeout 2 -fsS http://127.0.0.1:8080/ && ! curl --connect-timeout 2 -fsS http://10.0.2.2/ && ! curl --connect-timeout 2 -fsS http://169.254.169.254/ && ! curl -g --connect-timeout 2 -fsS 'http://[::1]:3098/' && ! curl -g --connect-timeout 2 -fsS 'http://[::ffff:127.0.0.1]:8080/'",
  );
  await shell(
    "getent ahostsv4 example.com >/dev/null && curl --connect-timeout 5 -fsS https://example.com/ >/dev/null && curl --connect-timeout 2 -fsS http://127.0.0.1:3098/ >/dev/null",
  );
  const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const browserScript = `import {chromium} from '/opt/agent/node_modules/playwright/index.mjs'; const b=await chromium.launch({headless:true,chromiumSandbox:true});try{const p=await b.newPage();let blocked=false;try{await p.goto('http://127.0.0.1:8080/',{timeout:3000})}catch{blocked=true}if(!blocked)throw Error('control API reachable');await p.goto('http://127.0.0.1:3098/');if(!await p.title())throw Error('preview failed')}finally{await b.close()}`;
  await shell(
    `/opt/agent-node/bin/node --input-type=module -e ${shellQuote(browserScript)}`,
  );
  await runner.call(id, "write", {
    path: "project/dependency/package.json",
    text: '{"name":"guest-local-fixture","version":"1.0.0","main":"index.js"}',
  });
  await runner.call(id, "write", {
    path: "project/dependency/index.js",
    text: "module.exports = 42;\n",
  });
  await shell(
    "cd project && npm install --ignore-scripts --no-audit --no-fund ./dependency && node -e 'if(require(\"guest-local-fixture\")!==42)process.exit(1)' && python3 -m venv .venv",
  );
  assert.equal((await runner.call(id, "cleanup", {})).cleanup, true);
  await runner.close();
  await writeFile(
    probePath,
    `import {WorkerClient} from '/opt/agent/dist/src/execution/client.js';const r=new WorkerClient();await r.ready();await r.call('${id}','shell',{command:'setsid /bin/sh -c "sleep 300" >/dev/null 2>&1 & wait',timeout:300,maxBytes:1048576});`,
    { flag: "wx", mode: 0o644 },
  );
  command("systemd-run", [
    "--unit",
    unit,
    "--collect",
    "--property=User=agent-control",
    "--property=Group=agent-control",
    "--property=KillMode=control-group",
    "--property=TimeoutStopSec=3",
    "/opt/agent-node/bin/node",
    probePath,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const before = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if ((await lstat(`/proc/${pid}`)).uid === 981) before.push(pid);
    } catch {}
  }
  assert.ok(before.length > 0, "The cgroup probe did not start a real worker");
  command("systemctl", ["stop", unit]);
  for (const pid of before)
    assert.equal(
      existsSync(`/proc/${pid}`),
      false,
      "A worker escaped service cgroup cleanup",
    );
  const lock = "/srv/agent-data/control/writer.lock";
  const first = spawn("flock", ["-n", lock, "/bin/sleep", "3"]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    spawnSync("flock", ["-n", "-E", "73", lock, "/usr/bin/true"]).status,
    73,
  );
  first.kill();
  console.log(
    JSON.stringify({
      result: "pass",
      ids,
      limitations:
        "This guest probe does not establish Windows/WHPX, real provider quality, host sleep, or backup restoration acceptance",
    }),
  );
} finally {
  await runner.close().catch(() => undefined);
  controller?.kill();
  privateServer.closeAllConnections();
  previewServer.closeAllConnections();
  privateServer.close();
  previewServer.close();
  spawnSync("systemctl", ["stop", unit]);
  await unlink(secret).catch(() => undefined);
  await unlink(probePath).catch(() => undefined);
  await rm(`/srv/agent-data/work/jobs/${id}`, { recursive: true, force: true });
}
