import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer as portProbe } from "node:net";
import { chromium } from "playwright";
import { fixture } from "../support.js";
import { skillsFixture } from "../skills-fixture.js";
import { createServer } from "../../src/server.js";

test("Skills settings import folders, edit and delete with validation in light, dark and narrow layouts", async () => {
  const s = await skillsFixture();
  await s.add(
    "pdf-processing",
    "name: pdf-processing\ndescription: PDF からテキストを抽出\ncompatibility: Python 3",
  );
  await s.add("invalid", "name: invalid\ndescription: ''");
  const f = await fixture([], { root: s.root, skills: s.loader });
  const probe = portProbe();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done) => probe.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  f.config.server.origins = [origin];
  const server = await createServer(f.service, resolve("dist/web") + "/");
  await server.listen({ host: "127.0.0.1", port });
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(origin);
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    const panel = page.getByRole("region", { name: "Skills 一覧" });
    await panel.getByText("pdf-processing", { exact: true }).waitFor();
    await panel.getByText("PDF からテキストを抽出", { exact: true }).waitFor();
    await panel.getByText("互換性: Python 3", { exact: true }).waitFor();
    await panel.getByText("読み込みエラー", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "保存", exact: true }).count(),
      0,
    );
    const folder = resolve(s.root, "import-folder");
    await mkdir(resolve(folder, "scripts"), { recursive: true });
    const original =
      "---\nname: imported\ndescription: Imported skill\n---\nOriginal instructions";
    await writeFile(resolve(folder, "SKILL.md"), original);
    await writeFile(resolve(folder, "scripts/run.py"), "print('fixture')");
    await panel
      .getByRole("button", { name: "Skill を追加", exact: true })
      .click();
    await panel.locator("input[webkitdirectory]").setInputFiles(folder);
    const source = panel.getByRole("textbox", {
      name: "SKILL.md",
      exact: true,
    });
    await source.waitFor();
    await page.waitForFunction(() =>
      (
        document.querySelector(".skill-source") as HTMLTextAreaElement
      )?.value.includes("Original instructions"),
    );
    await panel.getByText("補助ファイル（1件）", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "追加", exact: true }).click();
    await panel
      .getByRole("heading", { name: "imported", exact: true })
      .waitFor();
    assert.equal(
      await readFile(resolve(s.root, "skills/imported/scripts/run.py"), "utf8"),
      "print('fixture')",
    );
    await panel.getByRole("button", { name: "imported を編集" }).click();
    await source.fill(
      original.replace("Original instructions", "Updated instructions"),
    );
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.setViewportSize({
        width: colorScheme === "dark" ? 390 : 1280,
        height: 900,
      });
      await mkdir("test-results", { recursive: true });
      await page.screenshot({ path: `test-results/skills-${colorScheme}.png` });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      const styles = await panel
        .locator("article")
        .first()
        .evaluate((node) => ({
          color: getComputedStyle(node).color,
          background: getComputedStyle(node).backgroundColor,
        }));
      assert.notEqual(styles.color, styles.background);
    }
    await panel.getByRole("button", { name: "保存", exact: true }).click();
    await source.waitFor({ state: "hidden" });
    assert.match(
      await readFile(resolve(s.root, "skills/imported/SKILL.md"), "utf8"),
      /Updated instructions/,
    );
    await panel.getByRole("button", { name: "imported を編集" }).focus();
    await page.keyboard.press("Enter");
    await source.waitFor();
    assert.equal(
      await source.inputValue(),
      original.replace("Original instructions", "Updated instructions"),
    );
    await panel
      .getByRole("button", { name: "キャンセル", exact: true })
      .click();
    assert.equal(
      await panel
        .getByRole("button", { name: "imported を編集" })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    page.once("dialog", (dialog) => void dialog.accept());
    await panel.getByRole("button", { name: "imported を削除" }).click();
    await panel
      .getByRole("heading", { name: "imported", exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(
      await panel
        .getByRole("button", { name: "Skill を追加", exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await rm(resolve(s.root, "skills/pdf-processing"), { recursive: true });
    await panel.getByRole("button", { name: "再読み込み" }).click();
    await panel
      .getByText("pdf-processing", { exact: true })
      .waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
    await f.service.close();
    await rm(s.root, { recursive: true });
  }
});
