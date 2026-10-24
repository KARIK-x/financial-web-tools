import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

const CREDENTIALS = readFileSync(path.join(process.cwd(), ".data", "demo-credentials.txt"), "utf8");
const PASSWORD = CREDENTIALS.match(/Shared password:\s*(\S+)/)![1]!;

const EMAILS = Object.fromEntries(
  [...CREDENTIALS.matchAll(/([a-z]+)@locus\.demo/g)].map((m) => [m[1]!, `${m[1]}@locus.demo`]),
) as Record<"admin" | "finance" | "executive" | "events" | "member" | "auditor", string>;

async function login(page: Page, who: keyof typeof EMAILS): Promise<void> {
  await page.goto("/login");
  await page.fill("#email", EMAILS[who]);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/overview/);
}

test.describe.serial("LOCUS finance end-to-end", () => {
  test("member can sign in and create a claim", async ({ page }) => {
    await login(page, "member");

    await expect(page.getByRole("link", { name: "My claims" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Approvals" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);

    await page.goto("/approvals");
    await expect(page.getByRole("heading", { name: "Access restricted" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Waiting for a decision" })).toHaveCount(0);

    await page.goto("/expenses/new");
    await expect(page.getByRole("heading", { name: "Record an expense" })).toBeVisible();
    await page.fill("#vendorName", "E2E Testing Supplies");
    await page.fill("#description", "E2E smoke test — printer paper for demo run");
    await page.fill("#amount", "1200");
    await page.selectOption("#categoryId", "cat_printing");
    await page.fill("#missingReceiptDeclaration", "Synthetic test claim created by the automated smoke test.");
    await page.getByRole("button", { name: "Save & submit" }).click();

    await expect(page).toHaveURL(/\/expenses\/[0-9a-f-]{36}$/);
    await expect(page.getByText("Submitted", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("E2E smoke test — printer paper for demo run").first()).toBeVisible();

    const claimLabel = await page.getByText(/^Claim · LOC-/).first().innerText();
    expect(claimLabel).toMatch(/LOC-\d{4}-\d{4}/);
    process.env.E2E_CLAIM_URL = page.url();
  });

  test("finance approves, pays and verifies the claim", async ({ page }) => {
    const claimUrl = process.env.E2E_CLAIM_URL;
    expect(claimUrl, "claim URL from the member test").toBeTruthy();

    await login(page, "finance");
    await page.goto(claimUrl!);

    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("Payment pending", { exact: true }).first()).toBeVisible();

    await page.fill("#pay-amount", "1200");
    await page.getByRole("button", { name: "Record payment" }).click();
    await expect(page.getByText("Reimbursed", { exact: true }).first()).toBeVisible();

    await page.fill("#verify-note", "E2E: declaration and amount checked.");
    await page.getByRole("button", { name: "Verify evidence" }).click();
    await expect(page.getByText(/Evidence verified/i).first()).toBeVisible();
    await expect(page.getByText("Verified", { exact: true }).first()).toBeVisible();
  });

  test("reconciliation shows the seeded statement and its open line", async ({ page }) => {
    await login(page, "finance");
    await page.goto("/reconciliation");
    await expect(page.getByRole("heading", { name: /Match the ledger/ })).toBeVisible();
    await page.getByRole("link", { name: "Review" }).first().click();
    await expect(page).toHaveURL(/import=/);
    await expect(page.getByText("Cash deposit — not yet recorded")).toBeVisible();
    await expect(page.getByText("Matched", { exact: true }).first()).toBeVisible();
  });

  test("auditor sees the audit trail but no approval actions", async ({ page }) => {
    await login(page, "auditor");
    await expect(page.getByRole("navigation").getByRole("link", { name: "Audit trail" })).toBeVisible();
    await expect(page.getByRole("navigation").getByRole("link", { name: "Approvals" })).toHaveCount(0);

    await page.goto("/audit");
    await expect(page.getByRole("heading", { name: /Who did what/ })).toBeVisible();
    await expect(page.locator("tbody").getByText("EXPENSE_SUBMITTED").first()).toBeVisible();
    await expect(page.getByText("Balanced").first()).toBeVisible();
  });

  test("admin can export claims as CSV and JSON", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/import-export");

    const csvDownload = page.waitForEvent("download");
    await page.locator('a[href*="/api/export/claims"][href*="format=csv"]').first().click();
    const csv = await csvDownload;
    const csvPath = await csv.path();
    expect(csvPath).toBeTruthy();
    const csvText = readFileSync(csvPath!, "utf8");
    expect(csvText.split("\r\n")[0]).toContain("claim_no");
    expect(csvText).toContain("amount_paisa");
    expect(csvText).toContain("amount_npr");

    const jsonDownload = page.waitForEvent("download");
    await page.locator('a[href*="/api/export/claims"][href*="format=json"]').first().click();
    const json = await jsonDownload;
    const jsonPath = await json.path();
    const payload = JSON.parse(readFileSync(jsonPath!, "utf8"));
    expect(Array.isArray(payload.records)).toBe(true);
    expect(payload.records.length).toBeGreaterThan(0);
    expect(payload.manifest.amountEncoding).toMatch(/integer paisa/i);
  });

  test("admin settings page loads the role matrix", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByText("Read-only Auditor").first()).toBeVisible();
  });
});
