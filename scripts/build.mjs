import { mkdir, copyFile, rm } from "node:fs/promises";
if (process.argv.includes("--clean")) {
  await rm("dist", { recursive: true, force: true });
} else if (process.argv.includes("--clean-tests")) {
  await rm(".test-dist", { recursive: true, force: true });
} else {
  await mkdir("dist/web", { recursive: true });
  await copyFile(
    "node_modules/bootstrap/dist/css/bootstrap.min.css",
    "dist/web/bootstrap.css",
  );
  await copyFile(
    "node_modules/bootstrap/LICENSE",
    "dist/web/bootstrap.LICENSE",
  );
  for (const name of ["index.html", "style.css"])
    await copyFile(`web/${name}`, `dist/web/${name}`);
}
