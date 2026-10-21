import { homedir } from "node:os";
import { join } from "node:path";

export function defaultBackend(
  platform = process.platform,
): "bubblewrap" | "disabled" {
  return platform === "linux" ? "bubblewrap" : "disabled";
}

export function defaultHome(
  platform = process.platform,
  home = homedir(),
): string {
  return platform === "darwin"
    ? join(home, "Library", "Application Support", "Local Agent")
    : join(home, ".local", "share", "local-agent");
}
