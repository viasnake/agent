import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const dependencies = {
  ...manifest.dependencies,
  ...manifest.devDependencies,
};

const stale = Object.entries(dependencies).some(([name]) => {
  const expected = lock.packages[`node_modules/${name}`]?.version;
  try {
    const actual = JSON.parse(
      readFileSync(join(root, "node_modules", name, "package.json"), "utf8"),
    ).version;
    return actual !== expected;
  } catch {
    return true;
  }
});

if (stale) {
  console.error(
    "依存関係が package-lock.json と一致しないため npm ci --ignore-scripts を実行します",
  );
  const result = spawnSync("npm", ["ci", "--ignore-scripts"], {
    stdio: "inherit",
    cwd: root,
  });
  process.exit(result.status ?? 1);
}
