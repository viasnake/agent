import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { loadConfig } from "../src/config.js";

test("V02 V06 V07 V08: VM script contracts, explicit public key, native seed, fixed loopback and no host service", async () => {
  for (const file of [
    "vm/init.sh",
    "vm/start.sh",
    "vm/guest-setup.sh",
    "vm/agent-work",
    "vm/agent-preflight",
  ])
    assert.equal(spawnSync("bash", ["-n", file]).status, 0, file);
  const root = await mkdtemp(join(tmpdir(), "agent-seed-")),
    key = join(root, "key.pub"),
    output = join(root, "seed");
  await writeFile(key, "ssh-ed25519 YWFhYmJiY2Nj fixture\n");
  const seed = spawnSync(
    "python3",
    ["vm/make-seed.py", "--ssh-key", key, "--output", output],
    { encoding: "utf8" },
  );
  assert.equal(seed.status, 0, seed.stderr);
  const config = parse(await readFile(join(output, "user-data"), "utf8")) as {
    users: { name: string; ssh_authorized_keys?: string[] }[];
    write_files: { path: string; content: string }[];
  };
  assert.equal(
    config.users[0]!.ssh_authorized_keys![0],
    "ssh-ed25519 YWFhYmJiY2Nj fixture",
  );
  assert.ok(config.users.some((user) => user.name === "agent-work"));
  assert.ok(
    config.write_files.some((file) => file.path.includes("agent-initial-disk")),
  );
  assert.notEqual(
    spawnSync("python3", [
      "vm/make-seed.py",
      "--ssh-key",
      key,
      "--output",
      output,
    ]).status,
    0,
  );
  for (const file of ["vm/start.sh", "vm/start.ps1"]) {
    const code = await readFile(file, "utf8");
    assert.match(code, /127\.0\.0\.1:8080-:8080/);
    assert.match(code, /127\.0\.0\.1:2222-:22/);
    assert.match(code, /AGENT_DATA_DISK/);
    assert.match(code, /recovery-hold/);
    assert.doesNotMatch(code, /-accel tcg|-virtfs|-qmp|-vnc/);
  }
  assert.match(await readFile("vm/init.ps1", "utf8"), /IMAPI2FS/);
  assert.match(await readFile("vm/init.ps1", "utf8"), /FileMode.CreateNew/);
  assert.match(
    await readFile("vm/agent.sudoers", "utf8"),
    /\(agent-work\).*NOSETENV.*agent-work ""/,
  );
  assert.match(
    await readFile("vm/agent.service", "utf8"),
    /KillMode=control-group/,
  );
  assert.match(
    await readFile("vm/agent.service", "utf8"),
    /NoNewPrivileges=no/,
  );
  const firewall = await readFile("vm/egress.nft", "utf8");
  assert.match(firewall, /meta nfproto ipv6 reject/);
  assert.match(firewall, /meta skuid != \$work_uid return/);
  assert.match(firewall, /127\.0\.0\.1 tcp dport 3000-3999 accept/);
  assert.match(
    await readFile("vm/resolv.conf", "utf8"),
    /^nameserver 10\.0\.2\.3$/m,
  );
  assert.match(await readFile("vm/agent-preflight", "utf8"), /nameserver/);
  const example = await loadConfig("examples/config.yaml");
  assert.equal(example.model, null);
  assert.equal(example.limits.modelRequests, 60);
});

test("V09: Linux flock refuses a duplicate writer before its command can touch SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-lock-")),
    lock = join(root, "writer.lock"),
    ready = join(root, "ready"),
    unexpected = join(root, "unexpected");
  const first = spawn("flock", [
    "-n",
    lock,
    process.execPath,
    "-e",
    `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{},10000)`,
  ]);
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await readFile(ready);
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    }
    const result = spawnSync("flock", [
      "-n",
      "-E",
      "73",
      lock,
      process.execPath,
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(unexpected)},'opened')`,
    ]);
    assert.equal(result.status, 73);
    await assert.rejects(readFile(unexpected));
    const main = await readFile("src/main.ts", "utf8");
    assert.ok(
      main.indexOf('"/usr/bin/flock"') < main.indexOf('"./service-main.js"'),
    );
  } finally {
    const exit = once(first, "exit");
    first.kill();
    await exit;
  }
});
