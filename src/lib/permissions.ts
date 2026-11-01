export const ROLES = ["ADMIN", "FINANCE", "EXECUTIVE", "EVENT_HEAD", "MEMBER", "AUDITOR"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Finance Manager",
  FINANCE: "Finance Team",
  EXECUTIVE: "Committee Executive",
  EVENT_HEAD: "Event / Department Head",
  MEMBER: "Member",
  AUDITOR: "Read-only Auditor",
};

export const PERMISSIONS = [
  "expense.submit", "expense.view.all", "expense.approve", "expense.pay", "expense.verify",
  "advance.manage", "document.upload", "document.view.all", "document.review", "document.search",
  "sponsor.manage", "budget.manage", "account.manage", "recon.manage",
  "report.view", "export.run", "audit.view", "settings.manage", "member.manage", "import.run",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: [...PERMISSIONS],
  FINANCE: PERMISSIONS.filter((p) => p !== "settings.manage"),
  EXECUTIVE: ["expense.submit", "expense.view.all", "expense.approve", "report.view", "audit.view", "document.view.all", "document.search"],
  EVENT_HEAD: ["expense.submit", "expense.view.all", "expense.approve", "report.view", "document.upload", "document.search"],
  MEMBER: ["expense.submit", "document.upload"],
  AUDITOR: ["expense.view.all", "document.view.all", "report.view", "audit.view", "document.search"],
};

export function can(role: Role, permission: Permission, overrides?: Permission[]): boolean {
  if (overrides) return overrides.includes(permission);
  return DEFAULT_ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
