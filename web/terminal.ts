import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { api } from "./api.js";

const host = document.querySelector<HTMLElement>("#terminal")!;
const status = document.querySelector<HTMLElement>("#status")!;
const button = document.querySelector<HTMLButtonElement>("#connection")!;
const terminal = new Terminal({
  fontSize: 14,
  fontFamily: "ui-monospace, monospace",
  scrollback: 1000,
  minimumContrastRatio: 4.5,
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(host);
const preferences = matchMedia("(prefers-color-scheme: dark)");
function theme() {
  const style = getComputedStyle(host);
  const palette = getComputedStyle(document.body);
  terminal.options.theme = {
    background: style.backgroundColor,
    foreground: palette.color,
    cursor: palette.color,
    cursorAccent: style.backgroundColor,
  };
}
theme();
preferences.addEventListener("change", theme);

let socket: WebSocket | undefined;
let generation = 0;
let connecting = false;
let ready = false;
const encoder = new TextEncoder();
function disconnect(message: string) {
  generation++;
  connecting = ready = false;
  socket?.close();
  socket = undefined;
  status.textContent = message;
  button.textContent = "接続";
}
function send(input: string | Uint8Array<ArrayBuffer>) {
  if (!ready || socket?.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount + input.length > 256 * 1024) {
    disconnect("入力が多すぎます。接続し直してください");
    return;
  }
  if (typeof input === "string") {
    socket.send(input);
    return;
  }
  for (let offset = 0; offset < input.length; offset += 64 * 1024)
    socket.send(input.subarray(offset, offset + 64 * 1024));
}
function resize() {
  const size = fit.proposeDimensions();
  if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows))
    return;
  const cols = Math.min(size.cols, 512);
  const rows = Math.min(size.rows, 256);
  terminal.resize(cols, rows);
  send(JSON.stringify({ cols, rows }));
}
new ResizeObserver(resize).observe(host);
terminal.onData((data) => send(encoder.encode(data)));
terminal.onBinary((data) =>
  send(Uint8Array.from(data, (byte) => byte.charCodeAt(0))),
);

async function connect() {
  const attempt = ++generation;
  connecting = true;
  terminal.reset();
  status.textContent = "接続中…";
  button.textContent = "切断";
  try {
    const { csrf } = await api<{ csrf: string }>("/api/session");
    if (generation !== attempt) return;
    const url = new URL("/api/terminal", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const current = new WebSocket(url, ["agent-terminal", `csrf.${csrf}`]);
    socket = current;
    current.binaryType = "arraybuffer";
    current.addEventListener("message", (event) => {
      if (generation !== attempt) return;
      if (event.data === "ready") {
        connecting = false;
        ready = true;
        status.textContent = "接続済み";
        resize();
        terminal.focus();
      } else if (event.data instanceof ArrayBuffer) {
        terminal.write(new Uint8Array(event.data));
      }
    });
    current.addEventListener("close", ({ code }) => {
      if (generation !== attempt) return;
      disconnect(
        code === 4000
          ? "別のターミナルが開いています"
          : code === 4001
            ? "利用時間の上限に達しました"
            : code === 4002
              ? "出力が多すぎます。接続し直してください"
              : code === 1000
                ? "終了しました"
                : "接続が切れました。接続し直してください",
      );
    });
  } catch {
    if (generation === attempt) disconnect("ターミナルに接続できませんでした");
  }
}
button.addEventListener("click", () => {
  if (connecting || ready) disconnect("切断しました");
  else void connect();
});
window.addEventListener("pagehide", () => disconnect("切断しました"));
void connect();
