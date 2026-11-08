import { userInfo } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadConfig, checkDataRoot } from "./config.js";

if (process.argv.includes("--help")) {
  console.log(
    "Usage: npm start -- /etc/agent/config.yaml\nStarts the local personal agent on prepared Ubuntu.\nApproved persistent storage, separated users and egress policy are required.",
  );
} else {
  if (
    process.platform !== "linux" ||
    !process.argv[2] ||
    userInfo().username !== "agent-control"
  )
    throw new Error("Run as agent-control on Linux with a config path");
  const config = await loadConfig(process.argv[2]);
  await checkDataRoot(config);
  // The supported entry point acquires the OS lock before importing code that opens SQLite.
  const child = spawn(
    "/usr/bin/flock",
    [
      "--exclusive",
      "--nonblock",
      "--conflict-exit-code",
      "73",
      "--no-fork",
      join(config.dataRoot, "control/writer.lock"),
      process.execPath,
      fileURLToPath(new URL("./service-main.js", import.meta.url)),
      process.argv[2],
    ],
    { stdio: "inherit", env: process.env },
  );
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => child.kill(signal));
  child.on("error", () => {
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    if (code === 73)
      console.error("Another service already owns this data set");
    process.exitCode = code ?? 1;
  });
}
