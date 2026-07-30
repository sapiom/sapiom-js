/**
 * Unit tests for definition-not-found helpers.
 *
 * Contract under test:
 *  - isDefinitionNotFoundError returns true for backend messages that indicate
 *    the linked definition id was not found on the user's account, and false
 *    for unrelated errors.
 *  - definitionNotFoundMessage produces a user-facing, actionable message that
 *    optionally includes the rejected definition id.
 */
import { describe, it, expect } from "vitest";
import { isDefinitionNotFoundError, definitionNotFoundMessage } from "./definition-not-found";

// ---------------------------------------------------------------------------
// isDefinitionNotFoundError
// ---------------------------------------------------------------------------

describe("isDefinitionNotFoundError", () => {
  it("matches the typical backend message shape", () => {
    expect(isDefinitionNotFoundError("Agent definition not found: 266")).toBe(true);
  });

  it("matches a short form without an id", () => {
    expect(isDefinitionNotFoundError("Definition not found.")).toBe(true);
  });

  it("matches lowercase", () => {
    expect(isDefinitionNotFoundError("definition not found")).toBe(true);
  });

  it("matches mixed case", () => {
    expect(isDefinitionNotFoundError("Definition Not Found")).toBe(true);
  });

  it("matches with extra context around the phrase", () => {
    expect(isDefinitionNotFoundError("Error: Agent definition not found: 1024")).toBe(true);
  });

  it("returns false for a network error", () => {
    expect(isDefinitionNotFoundError("Network error: connection refused")).toBe(false);
  });

  it("returns false for a generic not-found message without 'definition'", () => {
    expect(isDefinitionNotFoundError("workflow not found")).toBe(false);
  });

  it("returns false for an auth error", () => {
    expect(isDefinitionNotFoundError("Unauthorized: invalid API key")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isDefinitionNotFoundError("")).toBe(false);
  });

  it("returns false for a build error unrelated to definition lookup", () => {
    expect(isDefinitionNotFoundError("Build failed: TypeScript compilation error")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// definitionNotFoundMessage
// ---------------------------------------------------------------------------

describe("definitionNotFoundMessage", () => {
  it("includes the definition id when given as a number", () => {
    const msg = definitionNotFoundMessage(266);
    expect(msg).toContain("266");
    expect(msg).toContain("Deploy");
  });

  it("includes the definition id when given as a string", () => {
    const msg = definitionNotFoundMessage("266");
    expect(msg).toContain("266");
  });

  it("omits the id suffix when not provided", () => {
    const msg = definitionNotFoundMessage();
    expect(msg).not.toContain("id:");
    expect(msg).toContain("Deploy");
  });

  it("omits the id suffix when undefined is explicitly passed", () => {
    const msg = definitionNotFoundMessage(undefined);
    expect(msg).not.toContain("id:");
  });

  it("mentions the account context and deploy action", () => {
    const msg = definitionNotFoundMessage(42);
    expect(msg).toContain("your account");
    expect(msg).toContain("Deploy");
  });
});
