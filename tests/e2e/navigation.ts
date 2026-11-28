import type { Page } from "playwright";

export async function returnToSession(page: Page) {
  const selected = page.locator('.conversation-item[aria-current="true"]');
  const target = (await selected.count())
    ? selected
    : page.getByRole("button", { name: "新しいスレッド", exact: true });
  if (!(await target.isVisible()))
    await page
      .getByRole("button", { name: "スレッド一覧を開く", exact: true })
      .click();
  await target.click();
}
