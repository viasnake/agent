/**
 * 键位规范化。
 *
 * OpenTUI 的 KeyEvent、以及原有测试使用的原始转义序列，
 * 统一换算为「ctrl+p」「alt+enter」「pageUp」这类规范化 ID。
 * 序列解释层兼容原 pi-tui matchesKey 的行为。
 */
import { KeyEvent } from "@opentui/core";

export type KeyId =
  | "enter"
  | "escape"
  | "space"
  | "tab"
  | "backspace"
  | "delete"
  | "insert"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageUp"
  | "pageDown"
  | "shift+enter"
  | `f${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12}`
  | `${"ctrl" | "alt" | "shift" | "super" | "ctrl+shift" | "ctrl+alt" | "alt+shift" | "ctrl+alt+shift" | "ctrl+super" | "alt+super" | "shift+super" | "ctrl+alt+super" | "ctrl+shift+super" | "alt+shift+super" | "ctrl+alt+shift+super"}+${string}`;

export interface KeyLike {
  name: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  option?: boolean;
  super?: boolean;
  sequence?: string;
  raw?: string;
  eventType?: string;
}

/** OpenTUI のキー名をバインディング名に正規化する。 */
function normalizeKeyName(name: string): string {
  const lower = name.toLowerCase();
  switch (lower) {
    case "return":
    case "kpenter":
    case "enternum":
    case "enter":
      return "enter";
    case "esc":
    case "escape":
      return "escape";
    case "space":
    case " ":
      return "space";
    case "linefeed":
      return "j"; // ctrl+j 相当
    case "pageup":
    case "kppageup":
      return "pageUp";
    case "pagedown":
    case "kppagedown":
      return "pageDown";
    case "backspace":
    case "deletechar":
      return "backspace";
    case "delete":
    case "kpdelete":
      return "delete";
    case "insert":
      return "insert";
    case "clear":
      return "clear";
    case "home":
    case "kphome":
      return "home";
    case "end":
    case "kpend":
      return "end";
    case "up":
    case "kpup":
      return "up";
    case "down":
    case "kpdown":
      return "down";
    case "left":
    case "kpleft":
      return "left";
    case "right":
    case "kpright":
      return "right";
    case "tab":
      return "tab";
    default:
      return lower.length === 1 ? lower : lower;
  }
}

/** キーイベント（OpenTUI KeyEvent または簡易オブジェクト）を正規化 ID に変換する。 */
export function keyIdFromEvent(key: KeyLike): KeyId | undefined {
  if (key.eventType && key.eventType !== "press") return undefined;
  const name = normalizeKeyName(key.name ?? "");
  if (!name) return undefined;
  const mods: string[] = [];
  if (key.ctrl) mods.push("ctrl");
  if (key.meta || key.option) mods.push("alt");
  if (key.shift) mods.push("shift");
  if (key.super) mods.push("super");
  if (mods.length === 0) {
    // shift+enter は修飾のみで name 化しない
    if (name === "enter" && key.shift) return "shift+enter" as KeyId;
    return name as KeyId;
  }
  if (name === "space") return `${mods.join("+")}+space` as KeyId;
  return `${mods.join("+")}+${name}` as KeyId;
}

/**
 * 生の入力シーケンス（テストドライバが送る形式）を正規化 ID に変換する。
 * 識別できない場合（通常文字・貼り付けなど）は undefined。
 */
export function keyIdFromSequence(data: string): KeyId | undefined {
  if (data === "") return undefined;
  // 複数シーケンス・通常文字列・ブラケット貼り付けはキーとして扱わない
  if (data.length > 1 && !data.startsWith("\x1b")) return undefined;
  if (data.startsWith("\x1b[200~") || data.startsWith("\x1b[201~"))
    return undefined;

  if (data === "\x1b") return "escape";

  // C0 コントロール
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code === 0x0d) return "enter";
    if (code === 0x09) return "tab";
    if (code === 0x7f || code === 0x08) return "backspace";
    if (code === 0x0a) return "ctrl+j" as KeyId;
    if (code > 0 && code < 0x1b)
      return `ctrl+${String.fromCharCode(code + 0x60)}` as KeyId;
    if (code === 0) return "ctrl+space" as KeyId;
    return undefined;
  }

  // alt+<char>
  if (
    data.length === 2 &&
    data[0] === "\x1b" &&
    data[1] !== "[" &&
    data[1] !== "O"
  ) {
    const inner = keyIdFromSequence(data[1]!);
    if (inner && !inner.includes("+")) return `alt+${inner}` as KeyId;
    if (inner === "enter") return "alt+enter";
    return undefined;
  }

  // SS3
  if (data.startsWith("\x1bO")) {
    const tail = data.slice(2);
    const ss3: Record<string, string> = {
      P: "f1",
      Q: "f2",
      R: "f3",
      S: "f4",
      H: "home",
      F: "end",
      A: "up",
      B: "down",
      C: "right",
      D: "left",
      E: "clear",
      M: "enter",
    };
    const base = ss3[tail];
    if (base === "enter") return "shift+enter" as KeyId; // 従来のキーパッド Enter は改行扱い
    return base as KeyId | undefined;
  }

  if (!data.startsWith("\x1b[")) return undefined;
  const body = data.slice(2);

  // kitty CSI-u / CSI-number / modifyOtherKeys
  const kitty = body.match(/^(\d+)(?:;(\d*))?(?::\d*)?u$/);
  if (kitty) {
    const code = Number(kitty[1]);
    const mods = decodeCsiModifiers(Number(kitty[2] || "1"));
    return composeId(codePointName(code), mods);
  }
  const other = body.match(/^27;(\d+);(\d+)~$/);
  if (other) {
    const mods = decodeCsiModifiers(Number(other[1]));
    return composeId(codePointName(Number(other[2])), mods);
  }

  const tilde = body.match(/^(\d+)(?:;(\d+))?~$/);
  if (tilde) {
    // `\x1b[13;N~`（修飾あり）は Enter+修飾として扱う。無修飾の `13~` は F3。
    if (tilde[1] === "13" && tilde[2]) {
      const mods = decodeCsiModifiers(Number(tilde[2]));
      return composeId("enter", mods);
    }
    const nameMap: Record<string, string> = {
      "1": "home",
      "2": "insert",
      "3": "delete",
      "4": "end",
      "5": "pageUp",
      "6": "pageDown",
      "7": "home",
      "8": "end",
      "11": "f1",
      "12": "f2",
      "13": "f3",
      "14": "f4",
      "15": "f5",
      "17": "f6",
      "18": "f7",
      "19": "f8",
      "20": "f9",
      "21": "f10",
      "23": "f11",
      "24": "f12",
    };
    const base = nameMap[tilde[1]!];
    if (!base) return undefined;
    const mods = decodeCsiModifiers(Number(tilde[2] || "1"));
    return composeId(base, mods);
  }

  const letter = body.match(/^(?:(\d+)(?:;(\d+))?)?([ABCDHFZE])$/);
  if (letter) {
    const nameMap: Record<string, string> = {
      A: "up",
      B: "down",
      C: "right",
      D: "left",
      H: "home",
      F: "end",
      Z: "tab",
      E: "clear",
    };
    const base = nameMap[letter[3]!];
    if (!base) return undefined;
    let mods = decodeCsiModifiers(Number(letter[2] || letter[1] || "1"));
    if (letter[3] === "Z") mods = ["shift"];
    return composeId(base, mods);
  }
  return undefined;
}

function decodeCsiModifiers(value: number): string[] {
  const bits = Math.max(0, value - 1);
  const mods: string[] = [];
  if (bits & 1) mods.push("shift");
  if (bits & 2) mods.push("alt");
  if (bits & 4) mods.push("ctrl");
  // 正規化順序: ctrl, alt, shift, super
  const order = ["ctrl", "alt", "shift", "super"];
  return order.filter((m) => mods.includes(m));
}

function codePointName(code: number): string {
  if (code === 13) return "enter";
  if (code === 10) return "j";
  if (code === 9) return "tab";
  if (code === 32) return "space";
  if (code === 27) return "escape";
  if (code === 8 || code === 127) return "backspace";
  if (code > 0 && code < 0x80) return String.fromCharCode(code).toLowerCase();
  return "";
}

function composeId(base: string, mods: string[]): KeyId | undefined {
  if (!base) return undefined;
  if (base === "enter" && mods.length === 1 && mods[0] === "shift")
    return "shift+enter" as KeyId;
  if (mods.length === 0) return base as KeyId;
  return `${mods.join("+")}+${base}` as KeyId;
}

/** 入力（KeyEvent または生シーケンス）を正規化 ID に変換する。 */
export function keyIdFromInput(input: string | KeyLike): KeyId | undefined {
  if (typeof input === "string") return keyIdFromSequence(input);
  return keyIdFromEvent(input);
}

/** 正規化 ID から InputRenderable.handleKeyPress に渡せる KeyEvent を作る。 */
export function keyEventFromId(id: KeyId): KeyEvent {
  const parts = id.split("+");
  const name = parts.pop() ?? "";
  const mods = new Set(parts);
  const aliases: Record<string, string> = {
    enter: "return",
    escape: "escape",
    pageUp: "pageup",
    pageDown: "pagedown",
    space: "space",
  };
  return new KeyEvent({
    name: aliases[name] ?? name,
    ctrl: mods.has("ctrl"),
    meta: mods.has("alt"),
    shift: mods.has("shift"),
    option: false,
    super: mods.has("super"),
    sequence: "",
    number: false,
    raw: "",
    eventType: "press",
    source: "raw",
  });
}

/** 入力が指定のバインディングに一致するか。 */
export function matchesKey(input: string | KeyLike, id: KeyId): boolean {
  return keyIdFromInput(input) === id;
}
