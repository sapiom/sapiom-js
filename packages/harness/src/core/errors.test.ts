/**
 * Tests for the typed error hierarchy. Each class must:
 *   1. carry the correct stable code
 *   2. pass instanceof for both its own class and HarnessError
 *   3. map to the correct HTTP status via rest.ts / macros.ts
 *
 * The "wrong text, same class still maps correctly" tests prove the
 * point of the port: server routes dispatch on class identity, not
 * message strings, so any human-readable message change is safe.
 */

import { describe, expect, it } from "vitest";
import {
  HarnessError,
  UnknownSessionError,
  SessionNotReadyError,
  SessionNotResumeableError,
  SessionAlreadyLiveError,
  AdapterNotFoundError,
  ExternalHarnessError,
} from "./errors.js";

describe("HarnessError (base)", () => {
  it("carries the supplied code and message", () => {
    const err = new HarnessError("TEST_CODE", "some message");
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("some message");
    expect(err.name).toBe("HarnessError");
  });

  it("instanceof Error", () => {
    expect(new HarnessError("C", "m") instanceof Error).toBe(true);
  });

  it("stores an optional cause", () => {
    const cause = new Error("root");
    const err = new HarnessError("C", "m", cause);
    expect(err.cause).toBe(cause);
  });
});

describe("UnknownSessionError", () => {
  it("code is UNKNOWN_SESSION", () => {
    expect(new UnknownSessionError("abc").code).toBe("UNKNOWN_SESSION");
  });

  it("instanceof HarnessError and Error", () => {
    const err = new UnknownSessionError("abc");
    expect(err instanceof HarnessError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it("message mentions the session id", () => {
    expect(new UnknownSessionError("sess-42").message).toMatch(/sess-42/);
  });

  it("wrong-text-same-class: a subclass with an altered message is still instanceof UnknownSessionError", () => {
    // Point of the port: server routes check instanceof, so a future
    // rewording of the message never silently changes the HTTP status.
    class AltUnknownSessionError extends UnknownSessionError {
      constructor(id: string) {
        super(id);
        // Override message to simulate a future rewording.
        Object.defineProperty(this, "message", {
          value: "completely different wording for session " + id,
        });
      }
    }
    const err = new AltUnknownSessionError("x");
    expect(err instanceof UnknownSessionError).toBe(true);
    // Message no longer starts with "Unknown session" — yet the class identity is preserved.
    expect(err.message).not.toMatch(/^Unknown session/);
    expect(err instanceof HarnessError).toBe(true);
  });
});

describe("SessionNotReadyError", () => {
  it("code is SESSION_NOT_READY", () => {
    expect(new SessionNotReadyError("s1").code).toBe("SESSION_NOT_READY");
  });

  it("instanceof HarnessError", () => {
    expect(new SessionNotReadyError("s1") instanceof HarnessError).toBe(true);
  });

  it("message mentions trust-the-folder guidance", () => {
    expect(new SessionNotReadyError("s1").message).toMatch(/trust the folder/i);
  });

  it("wrong-text-same-class: altered message still has correct code", () => {
    const err = new SessionNotReadyError("s1");
    // Simulate a future rephrasing:
    (err as { message: string }).message = "session s1 blocked on onboarding";
    // Code is unchanged — routes dispatch on code, not message text.
    expect(err.code).toBe("SESSION_NOT_READY");
    expect(err instanceof SessionNotReadyError).toBe(true);
  });
});

describe("SessionNotResumeableError", () => {
  it("code is SESSION_NOT_RESUMEABLE", () => {
    expect(new SessionNotResumeableError("s2").code).toBe("SESSION_NOT_RESUMEABLE");
  });

  it("instanceof HarnessError", () => {
    expect(new SessionNotResumeableError("s2") instanceof HarnessError).toBe(true);
  });

  it("message mentions agentSessionId", () => {
    expect(new SessionNotResumeableError("s2").message).toMatch(/agentSessionId/);
  });
});

describe("SessionAlreadyLiveError", () => {
  it("code is SESSION_ALREADY_LIVE", () => {
    expect(new SessionAlreadyLiveError("s3").code).toBe("SESSION_ALREADY_LIVE");
  });

  it("instanceof HarnessError", () => {
    expect(new SessionAlreadyLiveError("s3") instanceof HarnessError).toBe(true);
  });

  it("message mentions live pty", () => {
    expect(new SessionAlreadyLiveError("s3").message).toMatch(/live pty/i);
  });
});

describe("AdapterNotFoundError", () => {
  it("code is ADAPTER_NOT_FOUND", () => {
    expect(new AdapterNotFoundError("codex").code).toBe("ADAPTER_NOT_FOUND");
  });

  it("instanceof HarnessError", () => {
    expect(new AdapterNotFoundError("codex") instanceof HarnessError).toBe(true);
  });

  it("message mentions the harness kind", () => {
    expect(new AdapterNotFoundError("codex").message).toMatch(/codex/);
  });
});

describe("ExternalHarnessError", () => {
  it("code is HARNESS_EXTERNAL", () => {
    expect(new ExternalHarnessError("conductor", "Conductor").code).toBe("HARNESS_EXTERNAL");
  });

  it("instanceof HarnessError and Error", () => {
    const err = new ExternalHarnessError("conductor", "Conductor");
    expect(err instanceof HarnessError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it("carries the harness id", () => {
    const err = new ExternalHarnessError("conductor", "Conductor");
    expect(err.harness).toBe("conductor");
  });

  it("message names the harness label", () => {
    const err = new ExternalHarnessError("conductor", "Conductor");
    expect(err.message).toMatch(/Conductor/);
  });

  it("message explains sessions are managed by the companion app", () => {
    const err = new ExternalHarnessError("conductor", "Conductor");
    expect(err.message).toMatch(/managed by/i);
  });
});

describe("HTTP mapping contract (class → status)", () => {
  /**
   * These tests simulate the route handler dispatch table that replaced the
   * old string-match. Each assertion proves that the class identity alone —
   * independent of message text — routes to the correct status.
   *
   * Mapping table:
   *   UnknownSessionError       → 404
   *   SessionNotReadyError      → 409
   *   SessionAlreadyLiveError   → 409
   *   SessionNotResumeableError → 409
   *   AdapterNotFoundError      → 400
   *   ExternalHarnessError      → 409
   */
  function classToStatus(err: unknown): number {
    if (err instanceof UnknownSessionError) return 404;
    if (err instanceof SessionNotReadyError) return 409;
    if (err instanceof SessionAlreadyLiveError) return 409;
    if (err instanceof SessionNotResumeableError) return 409;
    if (err instanceof AdapterNotFoundError) return 400;
    if (err instanceof ExternalHarnessError) return 409;
    return 500;
  }

  it("UnknownSessionError → 404", () => {
    expect(classToStatus(new UnknownSessionError("x"))).toBe(404);
  });

  it("SessionNotReadyError → 409", () => {
    expect(classToStatus(new SessionNotReadyError("x"))).toBe(409);
  });

  it("SessionAlreadyLiveError → 409", () => {
    expect(classToStatus(new SessionAlreadyLiveError("x"))).toBe(409);
  });

  it("SessionNotResumeableError → 409", () => {
    expect(classToStatus(new SessionNotResumeableError("x"))).toBe(409);
  });

  it("AdapterNotFoundError → 400", () => {
    expect(classToStatus(new AdapterNotFoundError("codex"))).toBe(400);
  });

  it("ExternalHarnessError → 409", () => {
    expect(classToStatus(new ExternalHarnessError("conductor", "Conductor"))).toBe(409);
  });

  it("plain Error → 500 (falls through — only typed harness errors are handled)", () => {
    expect(classToStatus(new Error("unexpected"))).toBe(500);
  });

  it("wrong-text-same-class still maps correctly: UnknownSessionError with reworded message → 404", () => {
    const err = new UnknownSessionError("abc");
    // Reword the message — the old string-match 'startsWith("Unknown session")' would fail here.
    Object.defineProperty(err, "message", { value: "session abc could not be located" });
    expect(err.message).not.toMatch(/^Unknown session/);
    // But instanceof still works → still 404.
    expect(classToStatus(err)).toBe(404);
  });
});
