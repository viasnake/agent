import { mkdir, copyFile, rm } from "node:fs/promises";
if (process.argv.includes("--clean")) {
  await rm("dist", { recursive: true, force: true });
} else if (process.argv.includes("--clean-tests")) {
  await rm(".test-dist", { recursive: true, force: true });
} else {
  await mkdir("dist/web", { recursive: true });
  for (const name of ["index.html", "style.css"])
    await copyFile(`web/${name}`, `dist/web/${name}`);
}
