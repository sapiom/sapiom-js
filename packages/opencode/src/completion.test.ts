import { expect, it } from "vitest";
import { AssistantContextError } from "./assistant-context-contract.js";
import { studioAssistantCompletionSystem } from "./completion.js";

it("uses one explicit attempt identity in every completion bookkeeping line", () => {
  const token = "12345678-1234-4234-8234-123456789abc";
  const system = studioAssistantCompletionSystem(token);
  expect(system.startsWith(`StudioAssistantResult/v2:${token}\n`)).toBe(true);
  expect(system).toContain(`<!-- studio-result:${token}:finished -->`);
  expect(system).toContain(`<!-- studio-result:${token}:failed -->`);
  expect(system.match(new RegExp(token, "g"))).toHaveLength(3);
});

it.each([
  "",
  "not-a-uuid",
  "12345678-1234-4234-8234-123456789ABC",
  "a".repeat(36),
  "12345678-1234-4234-8234-123456789abc\nother",
  null,
])(
  "rejects invalid explicit attempt identities with the shared safe error: %j",
  (token) => {
    expect(() => studioAssistantCompletionSystem(token as string)).toThrow(
      AssistantContextError,
    );
  },
);

it("creates fresh UUID attempts when none is supplied", () => {
  const first = studioAssistantCompletionSystem();
  const second = studioAssistantCompletionSystem();
  expect(first).toMatch(/^StudioAssistantResult\/v2:[a-f0-9-]{36}\n/);
  expect(first).not.toBe(second);
});
