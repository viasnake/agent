import type { Config, Paths } from "./config.js";
import { AgentError } from "./types.js";

export interface LoginInteraction {
  signal: AbortSignal;
  show(text: string): void;
  prompt(
    text: string,
    choices?: readonly { id: string; label: string }[],
    signal?: AbortSignal,
  ): Promise<string>;
}
// Pi authentication types stay behind the runtime/service boundary.
export async function interactiveLogin(
  config: Config,
  paths: Paths,
  name: string,
  ui: LoginInteraction,
): Promise<void> {
  const { login } = await import("./runtime/providers.js");
  // The prompt overlay replaces whatever ui.show displayed, so the last auth
  // link is repeated inside the prompt itself for the login to be completable.
  let authLink = "";
  await login(config, paths, name, {
    signal: ui.signal,
    notify: (event) => {
      if (event.type === "auth_url") {
        authLink = `${event.url}\n${event.instructions ?? ""}`.trimEnd();
        ui.show(authLink);
      } else if (event.type === "device_code") {
        authLink = `${event.verificationUri}\n${event.userCode}`;
        ui.show(authLink);
      } else ui.show(event.message);
    },
    prompt: (prompt) => {
      if (prompt.type === "secret")
        throw new AgentError("AUTH", "API キーは環境変数で指定してください。");
      return ui.prompt(
        authLink ? `${prompt.message}\n\n${authLink}` : prompt.message,
        prompt.type === "select" ? prompt.options : undefined,
        prompt.signal,
      );
    },
  });
}
export async function catalog(
  config: Config,
  paths: Paths,
  connection: string,
): Promise<{ id: string; name: string }[]> {
  const { connectionRuntime, providerId } =
    await import("./runtime/providers.js");
  const runtime = await connectionRuntime(config, paths, connection);
  return runtime
    .getModels(providerId(config.connections[connection]!))
    .map((m) => ({ id: m.id, name: m.name }));
}
