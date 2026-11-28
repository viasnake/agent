import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "../../src/server.js";
import { fixture, until } from "../support.js";
import { TerminalRunner } from "../terminal-fixture.js";

test(
  "real browser terminal handles hidden input, resize, Ctrl+C and tab close",
  { timeout: 40000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-terminal-browser-"));
    const runner = new TerminalRunner(join(root, "work"));
    const f = await fixture([], { root, runner });
    const probe = await createServer(f.service);
    const origin = await probe.listen({ host: "127.0.0.1", port: 0 });
    await probe.close();
    f.config.server.origins = [origin];
    const app = await createServer(f.service, resolve("dist/web") + "/");
    await app.listen({ host: "127.0.0.1", port: Number(new URL(origin).port) });
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ colorScheme: "light" });
      const page = await context.newPage();
      await page.goto(origin + "/?new");
      await page.locator("#message").fill("未送信の下書き");
      const popup = context.waitForEvent("page");
      await page.getByRole("link", { name: "ターミナル", exact: true }).click();
      const terminal = await popup;
      const errors: string[] = [];
      await terminal.bringToFront();
      terminal.on("pageerror", (error) => errors.push(error.message));
      terminal.on("console", (entry) => {
        if (entry.type() === "error") errors.push(entry.text());
      });
      await terminal.getByText("接続済み", { exact: true }).waitFor();
      const screen = terminal.locator(".xterm-rows");
      async function waitForLine(text: string) {
        await until(
          async () =>
            (await screen.innerText())
              .split("\n")
              .some((line) => line.trim() === text),
          7000,
        ).catch(async (error) => {
          throw new Error(
            `Expected line: ${text}\n${await terminal.locator("#status").innerText()}\n${await screen.innerText()}\n${errors.join("\n")}`,
            { cause: error },
          );
        });
      }
      async function enter(text: string) {
        await terminal.keyboard.insertText(text);
        await terminal.keyboard.press("Enter");
      }
      await enter(
        'test -t 0 && test -t 1 && test "$PWD" = "$HOME" && ' +
          'test -z "${AGENT_TERMINAL_TEST_SECRET-}" && ' +
          'read -rs -p "Device code: " value && printf %s "$value" > "$HOME/.device-test" && ' +
          'printf "\\nLogin %s\\n" complete',
      );
      await waitForLine("Device code:");
      await enter("synthetic-device-code");
      await waitForLine("Login complete");
      assert.doesNotMatch(await screen.innerText(), /synthetic-device-code/);
      assert.equal(
        await readFile(join(root, "work", "home", ".device-test"), "utf8"),
        "synthetic-device-code",
      );

      const before = await screen.locator(":scope > div").count();
      await terminal.setViewportSize({ width: 840, height: 490 });
      await until(
        async () => (await screen.locator(":scope > div").count()) !== before,
      );
      const rows = await screen.locator(":scope > div").count();
      await enter("printf 'PTY rows: %s\\n' \"$(stty size | cut -d' ' -f1)\"");
      await waitForLine(`PTY rows: ${rows}`);
      await enter("printf 'Foreground %s\\n' ready; sleep 120");
      await waitForLine("Foreground ready");
      await terminal.keyboard.press("Control+c");
      await until(async () =>
        /[#$]$/.test((await screen.innerText()).trimEnd()),
      );
      await enter("printf 'Still %s\\n' running");
      await waitForLine("Still running");

      const foreground = screen
        .locator(":scope > div")
        .filter({ hasText: "Still running" })
        .first();
      const light = await foreground.evaluate(
        (element) => getComputedStyle(element).color,
      );
      await terminal.emulateMedia({ colorScheme: "dark" });
      await until(
        async () =>
          (await foreground.evaluate(
            (element) => getComputedStyle(element).color,
          )) !== light,
      );
      await terminal.close();
      await until(async () => !f.service.busy);
      assert.equal(
        await page.locator("#message").inputValue(),
        "未送信の下書き",
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await app.close();
      await f.service.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
