/**
 * Unit tests for run-input-error helpers.
 *
 * Contract under test:
 *  - parseMissingInputFields extracts field names from input-validation failure
 *    messages, deduplicates them, preserves order, and returns [] for any
 *    message that is NOT an input-validation failure.
 *  - isInputValidationError returns true for both explicit-field and
 *    general-validation failures, and false for unrelated errors.
 */
import { describe, it, expect } from "vitest";
import { parseMissingInputFields, isInputValidationError } from "./run-input-error";

// ---------------------------------------------------------------------------
// parseMissingInputFields
// ---------------------------------------------------------------------------

describe("parseMissingInputFields", () => {
  it("extracts a single field from the runtime message shape", () => {
    const msg =
      "Input for step 'research' failed validation: topic: must have required property 'topic'";
    expect(parseMissingInputFields(msg)).toEqual(["topic"]);
  });

  it("extracts multiple fields in order", () => {
    const msg =
      "must have required property 'topic', must have required property 'count'";
    expect(parseMissingInputFields(msg)).toEqual(["topic", "count"]);
  });

  it("deduplicates repeated field names", () => {
    const msg =
      "must have required property 'topic' and must have required property 'topic'";
    expect(parseMissingInputFields(msg)).toEqual(["topic"]);
  });

  it("handles field names without quotes", () => {
    const msg = "must have required property query";
    expect(parseMissingInputFields(msg)).toEqual(["query"]);
  });

  it("handles field names with double quotes", () => {
    const msg = 'must have required property "emailAddress"';
    expect(parseMissingInputFields(msg)).toEqual(["emailAddress"]);
  });

  it("returns [] for 'failed validation' with no specific field names", () => {
    // A general validation failure: the dialog should open, but no fields
    // can be pre-named.
    expect(parseMissingInputFields("Input failed validation")).toEqual([]);
  });

  it("returns [] for a non-input failure message", () => {
    expect(parseMissingInputFields("Network error: connection refused")).toEqual([]);
  });

  it("returns [] for an empty string", () => {
    expect(parseMissingInputFields("")).toEqual([]);
  });

  it("returns [] for a timeout error", () => {
    expect(parseMissingInputFields("step timed out after 30s")).toEqual([]);
  });

  it("preserves insertion order of first occurrence when multiple fields appear", () => {
    const msg =
      "required property 'b', required property 'a', required property 'c', required property 'b'";
    expect(parseMissingInputFields(msg)).toEqual(["b", "a", "c"]);
  });

  it("handles underscore-containing field names", () => {
    const msg = "must have required property 'user_id'";
    expect(parseMissingInputFields(msg)).toEqual(["user_id"]);
  });

  it("handles numeric-containing field names", () => {
    const msg = "must have required property 'field2'";
    expect(parseMissingInputFields(msg)).toEqual(["field2"]);
  });
});

// ---------------------------------------------------------------------------
// isInputValidationError
// ---------------------------------------------------------------------------

describe("isInputValidationError", () => {
  it("returns true for a required-property message", () => {
    expect(
      isInputValidationError(
        "Input for step 'research' failed validation: topic: must have required property 'topic'",
      ),
    ).toBe(true);
  });

  it("returns true for a general 'failed validation' message", () => {
    expect(isInputValidationError("Input failed validation")).toBe(true);
  });

  it("returns false for a network error", () => {
    expect(isInputValidationError("Network error: connection refused")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isInputValidationError("")).toBe(false);
  });

  it("returns false for a step logic error", () => {
    expect(isInputValidationError("TypeError: Cannot read property 'id' of undefined")).toBe(false);
  });

  it("is case-insensitive for 'failed validation'", () => {
    expect(isInputValidationError("FAILED VALIDATION")).toBe(true);
    expect(isInputValidationError("Failed Validation")).toBe(true);
  });
});
