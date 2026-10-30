import { describe, expect, it } from "vitest";
import { createTestDb, createPerson } from "./helpers/fixtures";
import { createDelegation, hasActiveDelegation, listDelegations, revokeDelegation } from "@/server/delegations";

describe("approval delegations", () => {
  it("creates, detects, and revokes an active delegation", async () => {
    const db = await createTestDb();
    try {
      const admin = await createPerson(db, { role: "ADMIN", name: "Delegate Admin", member: false });
      const finance = await createPerson(db, { role: "FINANCE", name: "Delegate Finance", member: false });
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const id = await createDelegation(db, admin, { delegateeId: finance.id, expiresAt, reason: "Handover" });
      expect(await hasActiveDelegation(db, finance.id)).toBe(true);
      expect((await listDelegations(db)).some((d) => d.id === id)).toBe(true);
      await revokeDelegation(db, admin, id);
      expect(await hasActiveDelegation(db, finance.id)).toBe(false);
    } finally { await db.close(); }
  });

  it("rejects an expired delegation at creation", async () => {
    const db = await createTestDb();
    try {
      const admin = await createPerson(db, { role: "ADMIN", name: "Delegate Admin 2", member: false });
      const finance = await createPerson(db, { role: "FINANCE", name: "Delegate Finance 2", member: false });
      await expect(createDelegation(db, admin, {
        delegateeId: finance.id,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        reason: "Past",
      })).rejects.toThrow(/future/i);
    } finally { await db.close(); }
  });
});
