import { homedir } from "node:os";
import { join } from "node:path";

export function defaultBackend(
  platform = process.platform,
): "bubblewrap" | "podman" {
  return platform === "darwin" ? "podman" : "bubblewrap";
}

export function defaultHome(
  platform = process.platform,
  home = homedir(),
): string {
  return platform === "darwin"
    ? join(home, "Library", "Application Support", "Local Agent")
    : join(home, ".local", "share", "local-agent");
}

// This environment belongs to the trusted host client, never to a container.
export function podmanEnvironment(
  source = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: homedir(),
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  };
  for (const key of [
    "HOME",
    "PATH",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "CONTAINER_HOST",
    "CONTAINER_CONNECTION",
    "CONTAINER_SSHKEY",
    "SSH_AUTH_SOCK",
  ]) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}
