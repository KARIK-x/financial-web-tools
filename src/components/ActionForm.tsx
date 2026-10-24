"use client";

import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/action-result";

type Action = (state: ActionResult, formData: FormData) => Promise<ActionResult>;

export function ActionForm({
  action,
  children,
  submitLabel = "Save",
  submitClass = "btn btn-primary",
  className,
  footer,
  confirm,
  hideStatus,
  resetOnSuccess,
}: {
  action: Action;
  children: ReactNode;
  submitLabel?: string;
  submitClass?: string;
  className?: string;
  footer?: ReactNode;
  confirm?: string;
  hideStatus?: boolean;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const lastState = useRef<ActionResult>(null);

  useEffect(() => {
    if (!state || state === lastState.current) return;
    lastState.current = state;
    if (state.ok) {
      if (state.redirectTo) router.push(state.redirectTo);
      router.refresh();
      if (resetOnSuccess) formRef.current?.reset();
    }
  }, [state, router, resetOnSuccess]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className={className}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      {!hideStatus && state?.error ? <div className="error-box" role="alert">{state.error}</div> : null}
      {!hideStatus && state?.ok && state.message ? <div className="success-box">{state.message}</div> : null}
      {!hideStatus && state?.ok && state.warning ? <div className="warn-box">{state.warning}</div> : null}
      {children}
      {footer ?? (
        <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
          <button type="submit" className={submitClass} disabled={pending}>
            {pending ? "Working…" : submitLabel}
          </button>
        </div>
      )}
    </form>
  );
}

/** A compact single-button form for one-click transitions (approve, verify, ignore). */
export function QuickAction({
  action,
  label,
  fields,
  className = "btn btn-sm",
  confirm,
}: {
  action: Action;
  label: string;
  fields?: Record<string, string>;
  className?: string;
  confirm?: string;
}) {
  return (
    <ActionForm action={action} submitLabel={label} submitClass={className} confirm={confirm} hideStatus>
      {Object.entries(fields ?? {}).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
    </ActionForm>
  );
}
