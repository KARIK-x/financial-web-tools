"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { ActionResult } from "@/lib/action-result";

type Action = (state: ActionResult, formData: FormData) => Promise<ActionResult>;

export function MfaSetupForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="grid">
      {state?.error ? <div className="error-box" role="alert">{state.error}</div> : null}
      {state?.ok && state.message ? (
        <div className="success-box" style={{ whiteSpace: "pre-wrap", fontFamily: "var(--mono)", lineHeight: 1.7 }}>
          {state.message}
        </div>
      ) : null}
      <div className="field">
        <label className="label" htmlFor="code">Six-digit code from your authenticator</label>
        <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required placeholder="123456" />
        <span className="hint">Codes rotate every 30 seconds. If the code is rejected, check your device clock.</span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? "Verifying…" : "Enable two-factor authentication"}
        </button>
        {state?.ok ? <Link className="btn" href="/overview">I saved my recovery codes — continue</Link> : null}
      </div>
    </form>
  );
}
