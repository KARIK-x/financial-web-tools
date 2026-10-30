import { describe, expect, it, vi } from "vitest";
import { logEvent } from "@/server/logger";

describe("structured logging", () => {
  it("emits JSON with the event and safe context", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      logEvent("info", "request.completed", { requestId: "req-1", route: "/api/health", status: 200, durationMs: 12 });
      expect(spy).toHaveBeenCalledOnce();
      const parsed = JSON.parse(String(spy.mock.calls[0]?.[0]));
      expect(parsed).toMatchObject({
        level: "info",
        event: "request.completed",
        requestId: "req-1",
        route: "/api/health",
        status: 200,
        durationMs: 12,
      });
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      spy.mockRestore();
    }
  });

  it("routes warnings and errors to the matching console method", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      logEvent("warn", "slow.query", { durationMs: 1000 });
      logEvent("error", "payment.failed", { status: 500 });
      expect(warn).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
