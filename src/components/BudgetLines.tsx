"use client";

import { useState } from "react";

type Category = { id: string; name: string; group_name: string };

export function BudgetLines({ categories }: { categories: Category[] }) {
  const [rows, setRows] = useState<number[]>([0, 1, 2]);
  const next = () => setRows((r) => [...r, (r[r.length - 1] ?? -1) + 1]);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 8 }} className="tiny muted uppercase">
        <span>Category</span>
        <span>Amount (NPR)</span>
      </div>
      {rows.map((i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 8 }}>
          <select name={`lines[${i}][categoryId]`} defaultValue="">
            <option value="">— none —</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input name={`lines[${i}][amount]`} inputMode="decimal" placeholder="0" />
        </div>
      ))}
      <div>
        <button type="button" className="btn btn-xs" onClick={next}>+ Add line</button>
      </div>
    </div>
  );
}
