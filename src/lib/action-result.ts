/** Shared shape returned by every server action used with useActionState. */
export type ActionResult = {
  ok: boolean;
  error?: string;
  message?: string;
  redirectTo?: string;
  /** Non-fatal warnings the user should read before continuing. */
  warning?: string;
} | null;
