import assert from "node:assert/strict";
import test from "node:test";

import { isTransientImageError } from "./index.ts";

test("uses structured image error status when available", () => {
  assert.equal(isTransientImageError({ status: 503 }), true);
  assert.equal(isTransientImageError({ response: { status: "429" } }), true);
  assert.equal(
    isTransientImageError({ status: 400, message: "HTTP 503 in prompt" }),
    false,
  );
});

test("does not treat unrelated numbers as transient statuses", () => {
  assert.equal(isTransientImageError(new Error("failed after 500 ms")), false);
  assert.equal(isTransientImageError(new Error("request id 429")), false);
  assert.equal(isTransientImageError(new Error("HTTP 503 upstream")), true);
  assert.equal(isTransientImageError(new Error("status code = 429")), true);
  assert.equal(isTransientImageError(new Error("nothttp 503")), false);
  assert.equal(
    isTransientImageError(new Error("temporary network error")),
    true,
  );
});

test("handles long repetitive error messages without regex backtracking", () => {
  const message = `status${" ".repeat(100_000)}not-a-status`;
  assert.equal(isTransientImageError(new Error(message)), false);
});
