import { describe, expect, it } from "vitest";

import { shouldAskFolderTrust } from "./folder-trust";

const untrusted = { root: "/work/project", trusted: false, trustable: true };

describe("shouldAskFolderTrust (SAP-4381)", () => {
  it("asks for a Claude Code session in an added root that is not trusted yet", () => {
    expect(shouldAskFolderTrust("claude-code", untrusted)).toBe(true);
  });

  it("does not ask for another harness", () => {
    expect(shouldAskFolderTrust("codex", untrusted)).toBe(false);
  });

  it.each([
    ["already trusted", { ...untrusted, trusted: true, trustable: false }],
    ["not an added root", { root: null, trusted: false, trustable: false }],
    ["not writable (home, or no Claude Code config)", { ...untrusted, trustable: false }],
  ])("does not ask when the folder is %s", (_label, status) => {
    expect(shouldAskFolderTrust("claude-code", status)).toBe(false);
  });
});
