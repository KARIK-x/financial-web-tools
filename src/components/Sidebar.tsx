"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3, Bell, CalendarDays, CheckCircle2, ClipboardList, FolderOpen, Handshake, History,
  KeyRound, Landmark, LayoutDashboard, LogOut, Menu, Receipt, Scale, Settings, Store, TrendingUp,
  Upload, Users, Wallet, X,
} from "lucide-react";
import type { Permission } from "@/lib/permissions";
import { logoutAction } from "@/app/actions/auth";
import { ThemeToggle } from "@/components/ThemeToggle";

type Item = { href: string; label: string; icon: React.ElementType; permission?: Permission; count?: number };

export function Sidebar({
  user, pendingApprovals, unreconciled, missingDocs,
}: {
  user: { name: string; roleLabel: string; permissions: Permission[] };
  pendingApprovals: number;
  unreconciled: number;
  missingDocs: number;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const allows = (p?: Permission) => !p || user.permissions.includes(p);

  const groups: Array<{ label: string; items: Item[] }> = [
    {
      label: "Overview",
      items: [
        { href: "/overview", label: "Dashboard", icon: LayoutDashboard },
        { href: "/my-expenses", label: "My claims", icon: ClipboardList },
      ],
    },
    {
      label: "Spend",
      items: [
        { href: "/expenses", label: "Expenses", icon: Receipt, permission: "expense.view.all" },
        { href: "/approvals", label: "Approvals", icon: CheckCircle2, permission: "expense.approve", count: pendingApprovals },
        { href: "/receipts", label: "Receipts", icon: FolderOpen, permission: "document.view.all", count: missingDocs },
      ],
    },
    {
      label: "Money",
      items: [
        { href: "/advances", label: "Advances", icon: Wallet },
        { href: "/sponsors", label: "Sponsors", icon: Handshake, permission: "report.view" },
        { href: "/accounts", label: "Accounts", icon: Landmark, permission: "account.manage" },
        { href: "/reconciliation", label: "Reconciliation", icon: Scale, permission: "recon.manage", count: unreconciled },
      ],
    },
    {
      label: "Planning",
      items: [
        { href: "/events", label: "Events & budgets", icon: CalendarDays },
        { href: "/members", label: "Members", icon: Users, permission: "member.manage" },
        { href: "/vendors", label: "Vendors", icon: Store },
      ],
    },
    {
      label: "Intelligence",
      items: [
        { href: "/reports", label: "Reports", icon: BarChart3, permission: "report.view" },
        { href: "/analytics", label: "Analytics", icon: TrendingUp, permission: "report.view" },
        { href: "/reconstruction", label: "Reconstruction", icon: History, permission: "report.view" },
        { href: "/audit", label: "Audit trail", icon: History, permission: "audit.view" },
        { href: "/import-export", label: "Import & export", icon: Upload, permission: "import.run" },
        { href: "/notifications", label: "Notifications", icon: Bell },
        { href: "/settings", label: "Settings", icon: Settings, permission: "settings.manage" },
      ],
    },
  ];

  const initials = user.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  const nav = (
    <nav className="nav" aria-label="Primary navigation">
      {groups.map((group) => {
        const items = group.items.filter((i) => allows(i.permission));
        if (!items.length) return null;
        return (
          <div className="nav-group" key={group.label}>
            <div className="nav-label">{group.label}</div>
            {items.map((item) => {
              const active = pathname === item.href || (item.href !== "/overview" && pathname.startsWith(`${item.href}/`));
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href} className={`nav-link${active ? " active" : ""}`} aria-current={active ? "page" : undefined} onClick={() => setOpen(false)}>
                  <Icon />
                  <span>{item.label}</span>
                  {item.count ? <span className="nav-count">{item.count}</span> : null}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );

  return (
    <>
      <div className="topbar no-print">
        <button className="btn btn-ghost btn-icon" onClick={() => setOpen(true)} aria-label="Open navigation" aria-expanded={open} aria-controls="primary-navigation">
          <Menu size={18} />
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span className="brand-mark" style={{ width: 26, height: 26, fontSize: 15, background: "#0d5c4a", color: "#fff" }}>L</span>
          <span style={{ fontWeight: 600, letterSpacing: "0.02em" }}>LOCUS Finance</span>
        </div>
      </div>
      {open ? <div className="scrim no-print" onClick={() => setOpen(false)} /> : null}
      <aside id="primary-navigation" className={`sidebar no-print${open ? " open" : ""}`}>
        <div className="sidebar-brand">
          <span className="brand-mark">L</span>
          <div style={{ flex: 1 }}>
            <div className="brand-name">LOCUS</div>
            <div className="brand-sub">Finance Intelligence</div>
          </div>
          <button className="btn btn-ghost btn-icon" style={{ color: "#9aa1ac", display: open ? "inline-flex" : "none" }} onClick={() => setOpen(false)} aria-label="Close navigation">
            <X size={16} />
          </button>
        </div>
        {nav}
        <div className="sidebar-foot">
          <div className="user-chip">
            <span className="avatar">{initials || "?"}</span>
            <div style={{ minWidth: 0 }}>
              <div className="user-name" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.name}</div>
              <div className="user-role">{user.roleLabel}</div>
            </div>
          </div>
          <Link
            href="/change-password"
            className="tiny muted"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 8, textDecoration: "none" }}
          >
            <KeyRound size={12} /> Change password
          </Link>
          <div style={{ marginBottom: 10 }}>
            <ThemeToggle />
          </div>
          <form action={logoutAction}>
            <button type="submit">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <LogOut size={12} /> Sign out
              </span>
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
