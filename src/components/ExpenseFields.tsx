"use client";

import { useState } from "react";
import { formatNPR, parseMoney } from "@/lib/money";
import { adToBs, formatBsLong, todayISO } from "@/lib/nepali-date";

export function AmountField({
  name = "amount", defaultValue, thresholds, label = "Amount (NPR)",
}: {
  name?: string;
  defaultValue?: string;
  thresholds: { standard: number; executive: number; committee: number };
  label?: string;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const parsed = value ? parseMoney(value) : null;
  const paisa = parsed?.ok ? parsed.paisa : 0;

  let tier = "One finance approval";
  let detail = "Standard claims need a single finance-team decision.";
  if (paisa > thresholds.committee) {
    tier = "Committee approval";
    detail = "Finance + executive approval, plus a committee resolution reference.";
  } else if (paisa > thresholds.standard) {
    tier = "Finance + executive";
    detail = "Above the standard limit, two different approvers are required.";
  }

  return (
    <div className="field">
      <label className="label" htmlFor={name}>{label} <span className="req">*</span></label>
      <input
        id={name}
        name={name}
        inputMode="decimal"
        required
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. 3,500.50"
        autoComplete="off"
      />
      {value ? (
        parsed?.ok ? (
          <span className="hint">
            {formatNPR(paisa)} · {tier}. <span className="faint">{detail}</span>
          </span>
        ) : (
          <span className="hint" style={{ color: "var(--danger)" }}>{parsed?.error}</span>
        )
      ) : (
        <span className="hint">Nepali formats work: 1,50,000 · Rs. 3500 · 1.5 lakh</span>
      )}
    </div>
  );
}

export function DateField({
  name = "date", defaultValue, label = "Expense date (AD)",
}: { name?: string; defaultValue?: string; label?: string }) {
  const [value, setValue] = useState(defaultValue ?? todayISO());
  const bs = value ? adToBs(value) : null;
  return (
    <div className="field">
      <label className="label" htmlFor={name}>{label} <span className="req">*</span></label>
      <input id={name} name={name} type="date" required value={value} onChange={(e) => setValue(e.target.value)} />
      <span className="hint">{bs ? `Bikram Sambat: ${formatBsLong(bs)} (${bs})` : "Bikram Sambat equivalent is stored automatically."}</span>
    </div>
  );
}
