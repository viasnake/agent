import { join } from "node:path";
import { z } from "zod";
import type { KeyId } from "./keys.js";
import type { Paths } from "../config.js";
import { AgentError } from "../types.js";
import { atomicWrite, readText } from "../util.js";
import { actions, type ActionName, type KeyOverrides } from "./actions.js";

const modifierOrder = ["ctrl", "alt", "shift", "super"];

export function bindingKey(value: string): KeyId {
  const parts = value.split("+"),
    base = parts.pop()!,
    modifiers = [...new Set(parts)];
  if (
    modifiers.length !== parts.length ||
    modifiers.some((part) => !modifierOrder.includes(part)) ||
    !/^(?:[a-z0-9]|escape|enter|tab|space|backspace|delete|insert|home|end|pageUp|pageDown|up|down|left|right|f(?:[1-9]|1[0-2]))$/.test(
      base,
    ) ||
    (!modifiers.length && !/^(?:escape|pageUp|pageDown|f\d+)$/.test(base))
  )
    throw new AgentError(
      "KEY_BINDING",
      "修飾キー付きのキー、escape、pageUp、pageDown、f1〜f12 を指定してください。",
    );
  const key = [
    ...modifierOrder.filter((part) => modifiers.includes(part)),
    base,
  ].join("+");
  if (["ctrl+j", "ctrl+m", "ctrl+i", "ctrl+h", "shift+enter"].includes(key))
    throw new AgentError(
      "KEY_BINDING",
      "このキーは改行・入力保護に予約されています。",
    );
  return key as KeyId;
}

const actionNames = Object.keys(actions) as [ActionName, ...ActionName[]];
const schema = z.strictObject({
  schemaVersion: z.literal(1),
  keys: z
    .partialRecord(z.enum(actionNames), z.array(z.string().max(64)).max(4))
    .default({}),
  editor: z
    .array(
      z
        .string()
        .min(1)
        .max(2000)
        .refine((value) => !value.includes("\0")),
    )
    .min(1)
    .max(16)
    .default(["vi"]),
});
export interface TerminalPreferences {
  schemaVersion: 1;
  keys: KeyOverrides;
  editor: string[];
}
export function parsePreferences(input: unknown): TerminalPreferences {
  const parsed = schema.parse(input),
    keys: KeyOverrides = {},
    seen = new Map<string, string>();
  for (const name of actionNames) {
    const configured = parsed.keys[name];
    if (configured) keys[name] = configured.map(bindingKey);
    for (const key of keys[name] ?? actions[name].keys) {
      const owner = seen.get(key);
      if (owner)
        throw new AgentError(
          "KEY_BINDING",
          `${key} は ${owner} と ${name} で重複しています。`,
        );
      seen.set(key, name);
    }
  }
  return { schemaVersion: 1, keys, editor: parsed.editor };
}
export async function loadPreferences(
  paths: Paths,
): Promise<TerminalPreferences> {
  try {
    return parsePreferences(
      JSON.parse(await readText(join(paths.home, "terminal.json"), 32000)),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return parsePreferences({ schemaVersion: 1 });
    throw Object.assign(
      new AgentError(
        "TERMINAL_CONFIG",
        "端末設定 terminal.json を読み込めません。設定内容と権限を確認してください。",
      ),
      { cause: error },
    );
  }
}
export async function savePreferences(
  paths: Paths,
  input: TerminalPreferences,
): Promise<TerminalPreferences> {
  const preferences = parsePreferences(input);
  await atomicWrite(
    join(paths.home, "terminal.json"),
    JSON.stringify(preferences, null, 2),
  );
  return preferences;
}
