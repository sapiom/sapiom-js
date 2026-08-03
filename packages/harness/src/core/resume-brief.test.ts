import { describe, expect, it } from "vitest";

import {
  CHARS_PER_TOKEN,
  buildResumeBrief,
  deriveDigests,
  describeToolTarget,
  estimateBriefTokens,
} from "./resume-brief.js";
import type {
  SessionRecord,
  SessionRecordToolCall,
  SessionRecordTurn,
} from "../shared/types.js";

function toolCall(
  name: string,
  input: unknown,
  overrides: Partial<SessionRecordToolCall> = {},
): SessionRecordToolCall {
  return {
    name,
    input: typeof input === "string" ? input : JSON.stringify(input),
    responseSummary: null,
    responseTruncated: false,
    at: "2026-07-27T10:00:00.000Z",
    ...overrides,
  };
}

function turn(index: number, overrides: Partial<SessionRecordTurn> = {}): SessionRecordTurn {
  return {
    index,
    prompt: `prompt number ${index}`,
    promptAt: `2026-07-27T10:${String(index).padStart(2, "0")}:00.000Z`,
    toolCalls: [],
    assistantText: `reply number ${index}`,
    model: "claude-opus-5",
    usage: null,
    completedAt: `2026-07-27T10:${String(index).padStart(2, "0")}:30.000Z`,
    incomplete: false,
    ...overrides,
  };
}

/** The body of one `## `-headed section, so an assertion about (say) the files
 *  digest isn't accidentally satisfied by the turn list further down. */
function section(brief: string, heading: string): string {
  const start = brief.indexOf(heading);
  expect(start, `brief has no ${heading} section`).toBeGreaterThanOrEqual(0);
  const next = brief.indexOf("\n## ", start + heading.length);
  return next === -1 ? brief.slice(start) : brief.slice(start, next);
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const turns = overrides.turns ?? [turn(1)];
  return {
    harnessSessionId: "harness-1",
    mergedSessionIds: ["harness-1"],
    agentSessionId: "agent-1",
    harness: "claude-code",
    cwd: "/Users/dev/project",
    startedAt: "2026-07-27T10:00:00.000Z",
    endedAt: "2026-07-27T11:00:00.000Z",
    turnCount: turns.filter((t) => t.prompt !== null).length,
    eventCount: turns.length * 2,
    reconstructed: true,
    archivedAt: null, // folded from the live event log, not the archive
    limitations: [],
    ...overrides,
    turns,
  };
}

describe("buildResumeBrief", () => {
  describe("honesty", () => {
    it("always leads with the reconstruction disclaimer, whatever else is dropped", () => {
      // Even at a budget far below the preamble floor, the label survives:
      // an unlabelled reconstruction is the failure this feature exists to
      // prevent, so it is not a thing the budget is allowed to squeeze.
      for (const maxTokens of [6_000, 400, 10, 0]) {
        const brief = buildResumeBrief(record(), { maxTokens });
        expect(brief).toContain("reconstruction, not restored context");
        expect(brief).toContain("You are a **fresh session**");
        expect(brief).toContain("coding agent");
        expect(brief).toContain("Agent Studio");
        expect(brief).toContain("check the current state of the");
      }
    });

    it("spells out each machine-readable limitation in prose", () => {
      const brief = buildResumeBrief(
        record({ limitations: ["truncated-tool-output", "missing-assistant-text"] }),
      );
      expect(brief).toContain("Known gaps in this reconstruction");
      expect(brief).toContain("Tool output was size-capped");
      expect(brief).toContain("no assistant text at all");
      // Not asserted for a gap the record didn't report.
      expect(brief).not.toContain("ended mid-turn");
    });

    it("says a prompt was not recorded rather than inventing one", () => {
      const brief = buildResumeBrief(
        record({ turns: [turn(1, { prompt: null, promptAt: null })] }),
      );
      expect(brief).toContain("**Prompt:** _not recorded");
      expect(brief).not.toContain("prompt number 1");
    });

    it("marks a trailing turn that never completed", () => {
      const brief = buildResumeBrief(
        record({ turns: [turn(1, { incomplete: true, completedAt: null, assistantText: null })] }),
      );
      expect(brief).toContain("never completed");
    });
  });

  describe("what the session was", () => {
    it("carries title, cwd, branch, harness and the bound workflow with its definitionId", () => {
      const brief = buildResumeBrief(record(), {
        title: "Fix the retry backoff",
        gitBranch: "feat/SAP-2059",
        workflow: { name: "order-triage", path: "/Users/dev/project/order-triage", definitionId: 188 },
      });
      expect(brief).toContain("Fix the retry backoff");
      expect(brief).toContain("/Users/dev/project");
      expect(brief).toContain("feat/SAP-2059");
      expect(brief).toContain("claude-code");
      expect(brief).toContain("**Coding agent:** claude-code");
      expect(brief).toContain("**Bound agent:** order-triage");
      expect(brief).toContain("**Agent run:**");
      expect(brief).not.toContain("**Bound workflow:**");
      expect(brief.toLowerCase()).not.toContain("workflow");
      expect(brief).toContain("order-triage");
      expect(brief).toContain("definition 188");
    });

    it("says a workflow is not linked rather than printing a null definition", () => {
      const brief = buildResumeBrief(record(), {
        workflow: { name: "draft", path: "/Users/dev/project/draft", definitionId: null },
      });
      expect(brief).toContain("not yet linked to a deployed definition");
      expect(brief).not.toContain("definition null");
    });
  });

  describe("rolling summary", () => {
    it("includes it when present", () => {
      const brief = buildResumeBrief(record(), { summary: "Rewrote the backoff to be jittered." });
      expect(brief).toContain("Rolling summary of the prior session");
      expect(brief).toContain("Rewrote the backoff to be jittered.");
    });

    it("degrades to the turns alone when no summary was ever produced", () => {
      // The default case — the setting is opt-in — so the brief must be
      // useful without one and must not imply a summary exists.
      const brief = buildResumeBrief(record({ turns: [turn(1), turn(2)] }));
      expect(brief).not.toContain("Rolling summary");
      expect(brief).toContain("prompt number 2");
    });
  });

  describe("derived digests", () => {
    it("lists files written (not merely read), newest first, with edit counts", () => {
      const brief = buildResumeBrief(
        record({
          turns: [
            turn(1, {
              toolCalls: [
                toolCall("Read", { file_path: "/Users/dev/project/src/read-only.ts" }),
                toolCall("Edit", { file_path: "/Users/dev/project/src/a.ts" }),
                toolCall("Edit", { file_path: "/Users/dev/project/src/a.ts" }),
                toolCall("Write", { file_path: "/Users/dev/project/src/b.ts" }),
              ],
            }),
          ],
        }),
      );
      const files = section(brief, "## Files the prior session wrote to");
      expect(files).toContain("`src/b.ts`");
      expect(files).toContain("`src/a.ts` (2 edits)");
      // A file the session only read is not a file it wrote — it still shows
      // in the turn's tool list, which is why this is scoped to the section.
      expect(files).not.toContain("read-only.ts");
      expect(brief).toContain("`Read` src/read-only.ts");
      // Newest first.
      expect(files.indexOf("src/b.ts")).toBeLessThan(files.indexOf("src/a.ts"));
    });

    it("lists distinct shell commands and dedupes repeats", () => {
      const brief = buildResumeBrief(
        record({
          turns: [
            turn(1, {
              toolCalls: [
                toolCall("Bash", { command: "pnpm build" }),
                toolCall("Bash", { command: "pnpm build" }),
                toolCall("Bash", { command: "pnpm lint" }),
              ],
            }),
          ],
        }),
      );
      const commands = section(brief, "## Shell commands it ran");
      expect(commands.match(/pnpm build/g)).toHaveLength(1);
      expect(commands).toContain("pnpm lint");
    });

    it("reads codex's argv-array shell input as one command line", () => {
      const digests = deriveDigests(
        record({
          turns: [turn(1, { toolCalls: [toolCall("shell", { command: ["bash", "-lc", "pnpm test"] })] })],
        }),
      );
      expect(digests.commands).toEqual(["bash -lc pnpm test"]);
    });

    it("omits both sections entirely when the session wrote nothing and ran nothing", () => {
      const brief = buildResumeBrief(record());
      expect(brief).not.toContain("## Files the prior session wrote to");
      expect(brief).not.toContain("## Shell commands it ran");
    });
  });

  describe("tool targets", () => {
    it("names the file for a file tool and the command for a shell tool", () => {
      expect(
        describeToolTarget(toolCall("Edit", { file_path: "/Users/dev/project/src/a.ts" }), "/Users/dev/project"),
      ).toBe("src/a.ts");
      expect(describeToolTarget(toolCall("Bash", { command: "pnpm build" }), "/Users/dev/project")).toBe(
        "pnpm build",
      );
    });

    it("keeps a path outside the cwd absolute rather than emitting ../.. noise", () => {
      expect(describeToolTarget(toolCall("Edit", { file_path: "/etc/hosts" }), "/Users/dev/project")).toBe(
        "/etc/hosts",
      );
    });

    it("falls back to a flattened slice of input the collector truncated mid-JSON", () => {
      // A real shape: normalizer.truncateForPayload cuts a big tool_input, so
      // JSON.parse fails. The target must still say something rather than
      // rendering a bare tool name.
      const target = describeToolTarget(
        toolCall("Edit", '{"file_path":"/Users/dev/project/src/a.ts","old_st…[truncated 900 chars]'),
        "/Users/dev/project",
      );
      expect(target).toContain("file_path");
    });

    it("returns null for a tool call with no recorded input at all", () => {
      expect(describeToolTarget(toolCall("Bash", null as unknown as string, { input: null }), null)).toBeNull();
    });
  });

  describe("token budget", () => {
    const chatty = record({
      turns: Array.from({ length: 40 }, (_, i) =>
        turn(i + 1, {
          prompt: `prompt ${i + 1} ${"p".repeat(400)}`,
          assistantText: `reply ${i + 1} ${"r".repeat(400)}`,
          toolCalls: [toolCall("Edit", { file_path: `/Users/dev/project/src/file-${i}.ts` })],
        }),
      ),
    });

    it("stays within the budget", () => {
      for (const maxTokens of [6_000, 2_000, 800]) {
        const brief = buildResumeBrief(chatty, { maxTokens, maxTurns: 40 });
        expect(estimateBriefTokens(brief)).toBeLessThanOrEqual(maxTokens);
        expect(brief.length).toBeLessThanOrEqual(maxTokens * CHARS_PER_TOKEN);
      }
    });

    it("truncates oldest-first, keeping the newest turns", () => {
      const brief = buildResumeBrief(chatty, { maxTokens: 1_500, maxTurns: 40 });
      expect(brief).toContain("prompt 40 ");
      expect(brief).not.toContain("prompt 1 ");
      expect(brief).not.toContain("prompt 20 ");
    });

    it("keeps the summary while dropping turns to fit", () => {
      const summary = "The session was migrating the retry path to jittered backoff.";
      const brief = buildResumeBrief(chatty, { maxTokens: 900, maxTurns: 40, summary });
      expect(brief).toContain(summary);
      expect(estimateBriefTokens(brief)).toBeLessThanOrEqual(900);
    });

    it("says how many turns it omitted instead of silently shortening", () => {
      const brief = buildResumeBrief(chatty, { maxTokens: 1_500, maxTurns: 40 });
      expect(brief).toMatch(/The earliest \d+ of 40 recorded turns are omitted here/);
    });

    it("keeps the capped digests while turns are still being dropped", () => {
      // The digests cost a few hundred tokens for a WHOLE session, where one
      // verbose turn costs about as much — so trading the whole-session view
      // away to keep one more ancient turn is the wrong way round.
      const squeezed = buildResumeBrief(chatty, { maxTokens: 2_000, maxTurns: 40 });
      expect(squeezed).toMatch(/The earliest \d+ of 40 recorded turns are omitted/);
      expect(squeezed).toContain("## Files the prior session wrote to");
    });

    it("clamps an oversized summary only as a last resort, and marks the cut", () => {
      // A summary that busts the whole budget on its own is outside its
      // ≤500-word contract; the budget is still hard, so it gets clamped
      // rather than allowed through.
      const brief = buildResumeBrief(record({ turns: [] }), {
        maxTokens: 600,
        summary: "s".repeat(50_000),
      });
      expect(brief.length).toBeLessThanOrEqual(600 * CHARS_PER_TOKEN);
      expect(brief).toContain("…[truncated]");
    });

    it("drops the digests only once no turn is left to give, and says so", () => {
      const brief = buildResumeBrief(chatty, { maxTokens: 400, maxTurns: 40 });
      expect(brief).toContain("_No turns fit the context budget._");
      expect(brief).not.toContain("## Files the prior session wrote to");
      expect(brief).toContain("Also omitted to fit the context budget: files written");
      // Still labelled, and still under budget.
      expect(brief).toContain("reconstruction, not restored context");
      expect(brief.length).toBeLessThanOrEqual(400 * CHARS_PER_TOKEN);
    });
  });

  it("renders nothing turn-shaped for a record with no turns", () => {
    const brief = buildResumeBrief(record({ turns: [], turnCount: 0 }));
    expect(brief).not.toContain("## Recent turns");
    expect(brief).toContain("**Recorded turns:** 0");
  });
});
