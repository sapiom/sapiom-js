import { describe, expect, it } from "vitest";
import {
  openCodeStartupReasons,
  openCodeTransportErrorCodes,
  openCodeTransportFailure,
  parseOpenCodeStudioErrorEvent,
  parseOpenCodeTransportErrorBody,
  parseOpenCodeTransportFailure,
} from "./opencode-errors.js";

describe("OpenCode transport error contract", () => {
  it("round-trips every fixed code and startup reason", () => {
    for (const code of openCodeTransportErrorCodes) {
      if (code === "runtime_start_failed") continue;
      const failure = openCodeTransportFailure(code);
      expect(parseOpenCodeTransportFailure(failure)).toEqual(failure);
      expect(parseOpenCodeTransportErrorBody({ error: failure })).toEqual(
        failure,
      );
      expect(
        parseOpenCodeStudioErrorEvent({
          type: "studio.error",
          properties: failure,
        }),
      ).toEqual(failure);
    }
    for (const reason of openCodeStartupReasons) {
      const failure = openCodeTransportFailure("runtime_start_failed", reason);
      expect(parseOpenCodeTransportFailure(failure)).toEqual(failure);
    }
  });

  it("rejects unknown, inconsistent, or extra server-controlled fields", () => {
    const failure = openCodeTransportFailure("access_denied");
    for (const value of [
      { ...failure, message: "raw upstream diagnostic" },
      { ...failure, retryable: true },
      { ...failure, action: "sign_in" },
      { ...failure, detail: "private" },
      { ...failure, startupReason: "exited" },
      openCodeTransportFailure("runtime_start_failed", "exited"),
    ]) {
      if (value.code === "runtime_start_failed") {
        expect(
          parseOpenCodeTransportFailure({
            ...value,
            startupReason: "unknown",
          }),
        ).toBeNull();
      } else expect(parseOpenCodeTransportFailure(value)).toBeNull();
    }
    expect(
      parseOpenCodeStudioErrorEvent({
        type: "studio.error",
        properties: failure,
        sessionID: "ses_spoofed",
      }),
    ).toBeNull();
    expect(
      parseOpenCodeTransportErrorBody({ error: failure, diagnostic: true }),
    ).toBeNull();
  });
});
