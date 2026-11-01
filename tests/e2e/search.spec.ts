import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

const CREDENTIALS = readFileSync(path.join(process.cwd(), ".data", "demo-credentials.txt"), "utf8");
const PASSWORD = CREDENTIALS.match(/Shared password:\s*(\S+)/)![1]!;

test("document search finds an uploaded receipt by filename", async ({ page }) => {
  await page.goto("/login");
  await page.fill("#email", "admin@finance-tracker.demo");
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/overview/);

  await page.goto("/receipts");
  const unique = `search-test-${Date.now()}.png`;
  await page.setInputFiles("#file", {
    name: unique,
    mimeType: "image/png",
    buffer: Buffer.concat([
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
      Buffer.from(`\n${unique}`),
    ]),
  });
  await page.getByRole("button", { name: "Upload document" }).click();
  await expect(page).toHaveURL(/\/receipts\//);

  await page.goto(`/receipts?q=${encodeURIComponent(unique)}`);
  await expect(page.getByRole("link", { name: unique })).toBeVisible();
});
