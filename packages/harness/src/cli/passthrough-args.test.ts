import { describe, expect, it } from "vitest";

import { parsePassthroughArgv, suggestPassthroughHint } from "./passthrough-args.js";

describe("parsePassthroughArgv", () => {
  describe("the single form: [harness-flags] -- <agent> [child-args...]", () => {
    it("bare agent after --", () => {
      expect(parsePassthroughArgv(["--", "claude"])).toEqual({
        kind: "claude-code",
        agent: "claude",
        agentArgs: [],
        noAuth: false,
        noTelemetry: false,
      });
    });

    it("everything after the agent goes verbatim to the child", () => {
      expect(parsePassthroughArgv(["--", "claude", "-p", "hi there", "--model", "opus"])).toMatchObject({
        kind: "claude-code",
        agentArgs: ["-p", "hi there", "--model", "opus"],
      });
    });

    it("harness flags before the -- are consumed by the harness", () => {
      expect(parsePassthroughArgv(["--no-auth", "--no-telemetry", "--", "claude", "-p", "x"])).toEqual({
        kind: "claude-code",
        agent: "claude",
        agentArgs: ["-p", "x"],
        noAuth: true,
        noTelemetry: true,
      });
    });

    it("a single harness flag before the -- (codex resume)", () => {
      expect(parsePassthroughArgv(["--no-auth", "--", "codex", "resume"])).toMatchObject({
        kind: "codex",
        agentArgs: ["resume"],
        noAuth: true,
        noTelemetry: false,
      });
    });
  });

  describe("agent aliases", () => {
    it("claude maps to kind claude-code", () => {
      expect(parsePassthroughArgv(["--", "claude"])).toMatchObject({ kind: "claude-code", agent: "claude" });
    });

    it("claude-code maps to kind claude-code", () => {
      expect(parsePassthroughArgv(["--", "claude-code"])).toMatchObject({
        kind: "claude-code",
        agent: "claude-code",
      });
    });

    it("codex maps to kind codex", () => {
      expect(parsePassthroughArgv(["--", "codex"])).toMatchObject({ kind: "codex", agent: "codex" });
    });
  });

  describe("verbatim preservation after the agent", () => {
    it("harness-looking flags after the agent belong to the child", () => {
      expect(parsePassthroughArgv(["--", "claude", "--no-auth", "-m", "opus"])).toEqual({
        kind: "claude-code",
        agent: "claude",
        agentArgs: ["--no-auth", "-m", "opus"],
        noAuth: false,
        noTelemetry: false,
      });
    });

    it("a later -- reaches the child verbatim — no reinterpretation", () => {
      expect(parsePassthroughArgv(["--", "claude", "foo", "--", "bar"])).toMatchObject({
        agentArgs: ["foo", "--", "bar"],
      });
    });

    it("web-only-looking flags after the agent go to the child too", () => {
      expect(parsePassthroughArgv(["--", "codex", "--port", "4000"])).toMatchObject({
        kind: "codex",
        agentArgs: ["--port", "4000"],
      });
    });

    it("child argv containing its own -- (codex mcp add) survives intact", () => {
      expect(
        parsePassthroughArgv(["--", "codex", "mcp", "add", "sapiom-dev", "--", "npx", "-y", "@sapiom/mcp"]),
      ).toMatchObject({
        kind: "codex",
        agentArgs: ["mcp", "add", "sapiom-dev", "--", "npx", "-y", "@sapiom/mcp"],
      });
    });
  });

  describe("errors: bad tokens before the --", () => {
    it("--port before -- is an error", () => {
      expect(() => parsePassthroughArgv(["--port", "4000", "--", "claude"])).toThrow(
        /--port is not supported in passthrough mode/,
      );
    });

    it("--no-open before -- is an error", () => {
      expect(() => parsePassthroughArgv(["--no-open", "--", "claude"])).toThrow(
        /--no-open is not supported in passthrough mode/,
      );
    });

    it("--no-session before -- is an error", () => {
      expect(() => parsePassthroughArgv(["--no-session", "--", "codex"])).toThrow(
        /--no-session is not supported in passthrough mode/,
      );
    });

    it("--dev before -- is an error", () => {
      expect(() => parsePassthroughArgv(["--dev", "--", "codex"])).toThrow(
        /--dev is not supported in passthrough mode/,
      );
    });

    it("an unknown flag before -- is an error naming the valid flags", () => {
      expect(() => parsePassthroughArgv(["--bogus", "--", "claude"])).toThrow(
        /Unknown harness flag before '--': --bogus.*--no-auth, --no-telemetry/,
      );
    });

    it("a positional before -- is an error", () => {
      expect(() => parsePassthroughArgv(["./dir", "--", "claude"])).toThrow(
        /Unexpected argument before '--': \.\/dir/,
      );
    });
  });

  describe("errors: -- not followed by a known agent (no silent fallthrough)", () => {
    it("a bare trailing -- is an error listing the valid agents", () => {
      expect(() => parsePassthroughArgv(["--"])).toThrow(
        /Expected an agent after '--' \(valid agents: claude, claude-code, codex\)/,
      );
    });

    it("-- followed by a non-agent token is an error naming the token", () => {
      expect(() => parsePassthroughArgv(["--", "vim"])).toThrow(
        /Expected an agent after '--' .*claude, claude-code, codex.*got: vim/,
      );
    });

    it("harness flags then a bare -- is still an error", () => {
      expect(() => parsePassthroughArgv(["--no-auth", "--"])).toThrow(/Expected an agent after '--'/);
    });

    it("inherited-prototype names are not agents", () => {
      expect(() => parsePassthroughArgv(["--", "toString"])).toThrow(/got: toString/);
    });
  });

  describe("web-mode fallthrough (no -- anywhere → null)", () => {
    it("no args", () => {
      expect(parsePassthroughArgv([])).toBeNull();
    });

    it("a directory positional", () => {
      expect(parsePassthroughArgv(["./dir"])).toBeNull();
    });

    it("a bare agent-named token is a web-mode dir positional now", () => {
      expect(parsePassthroughArgv(["claude"])).toBeNull();
    });

    it("an agent-named token with flags stays web mode without a --", () => {
      expect(parsePassthroughArgv(["codex", "--foo"])).toBeNull();
    });

    it("web flags with a dir positional", () => {
      expect(parsePassthroughArgv(["--port", "4000", "./dir"])).toBeNull();
    });

    it("harness flags without a --", () => {
      expect(parsePassthroughArgv(["--no-auth", "--no-telemetry"])).toBeNull();
    });

    it("harness flags before an agent-named token still need the --", () => {
      expect(parsePassthroughArgv(["--no-auth", "claude"])).toBeNull();
    });
  });
});

describe("suggestPassthroughHint", () => {
  it("suggests the -- form for each agent name", () => {
    expect(suggestPassthroughHint("claude")).toBe("did you mean: sapiom-harness -- claude [args...]?");
    expect(suggestPassthroughHint("claude-code")).toBe(
      "did you mean: sapiom-harness -- claude-code [args...]?",
    );
    expect(suggestPassthroughHint("codex")).toBe("did you mean: sapiom-harness -- codex [args...]?");
  });

  it("returns null for anything that isn't an agent name", () => {
    expect(suggestPassthroughHint("./dir")).toBeNull();
    expect(suggestPassthroughHint("vim")).toBeNull();
    expect(suggestPassthroughHint("")).toBeNull();
    // Map-backed lookup: prototype property names must not match.
    expect(suggestPassthroughHint("toString")).toBeNull();
    expect(suggestPassthroughHint("constructor")).toBeNull();
  });
});
