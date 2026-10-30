export type LogLevel = "info" | "warn" | "error";

export type LogContext = {
  requestId?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  [key: string]: unknown;
};

/** Structured JSON logger. Callers must not pass secrets, tokens, or PII. */
export function logEvent(level: LogLevel, event: string, context: LogContext = {}): void {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...context,
  };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
