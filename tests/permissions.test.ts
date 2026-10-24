import { describe, expect, it } from "vitest";
import { can, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES, type Permission } from "@/lib/permissions";

describe("role permissions", () => {
  it("gives the Finance Manager (ADMIN) every permission", () => {
    for (const permission of PERMISSIONS) expect(can("ADMIN", permission)).toBe(true);
  });

  it("keeps role administration away from FINANCE", () => {
    expect(can("FINANCE", "settings.manage")).toBe(false);
    expect(can("FINANCE", "expense.pay")).toBe(true);
    expect(can("FINANCE", "recon.manage")).toBe(true);
  });

  it("restricts auditors to read-only permissions", () => {
    expect(can("AUDITOR", "expense.view.all")).toBe(true);
    expect(can("AUDITOR", "audit.view")).toBe(true);
    expect(can("AUDITOR", "expense.submit")).toBe(false);
    expect(can("AUDITOR", "expense.approve")).toBe(false);
    expect(can("AUDITOR", "export.run")).toBe(false);
  });

  it("scopes members to their own submissions and uploads", () => {
    expect(DEFAULT_ROLE_PERMISSIONS.MEMBER).toEqual(["expense.submit", "document.upload"]);
  });

  it("requires an approval-capable role for event heads and executives", () => {
    expect(can("EVENT_HEAD", "expense.approve")).toBe(true);
    expect(can("EVENT_HEAD", "expense.pay")).toBe(false);
    expect(can("EXECUTIVE", "expense.approve")).toBe(true);
    expect(can("EXECUTIVE", "settings.manage")).toBe(false);
  });

  it("honours explicit per-user overrides", () => {
    const overrides: Permission[] = ["expense.submit", "report.view"];
    expect(can("MEMBER", "report.view", overrides)).toBe(true);
    expect(can("MEMBER", "document.upload", overrides)).toBe(false);
    expect(can("ADMIN", "settings.manage", overrides)).toBe(false);
  });

  it("exposes a complete default matrix for every role", () => {
    for (const role of ROLES) {
      expect(Array.isArray(DEFAULT_ROLE_PERMISSIONS[role])).toBe(true);
    }
  });
});
