import { test, expect } from "@playwright/test";

test("login page has basic accessibility landmarks", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator('label[for="email"]')).toBeVisible();
  await expect(page.locator('label[for="password"]')).toBeVisible();
  await expect(page.locator(".skip-link")).toBeAttached();
});

test("keyboard users can reach the login form", async ({ page }) => {
  await page.goto("/login");
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.tagName ?? "");
  expect(["A", "BUTTON", "INPUT"]).toContain(focused);
  await expect(page.locator("#email")).toBeVisible();
});

test("health endpoint is available", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.status).toBe("ok");
});

test("mobile viewport keeps the login form usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await expect(page.locator("#email")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
});
