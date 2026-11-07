import { mkdir, copyFile, rm } from "node:fs/promises";
import { build } from "esbuild";
if (process.argv.includes("--clean")) {
  await rm("dist", { recursive: true, force: true });
} else if (process.argv.includes("--clean-tests")) {
  await rm(".test-dist", { recursive: true, force: true });
} else {
  await mkdir("dist/web", { recursive: true });
  await build({
    entryPoints: ["web/app.tsx"],
    outfile: "dist/web/app.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2023",
    minify: true,
    legalComments: "eof",
    define: { "process.env.NODE_ENV": '"production"' },
  });
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
