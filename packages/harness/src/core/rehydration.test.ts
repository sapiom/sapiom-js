import { describe, expect, it, vi } from "vitest";

import { buildRehydrationBrief, systemPromptDeliveryFor } from "./rehydration.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { CodexAdapter } from "./adapters/codex.js";
import type { HarnessAdapter, SessionRecord } from "../shared/types.js";

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    harnessSessionId: "harness-1",
    mergedSessionIds: ["harness-1"],
    agentSessionId: "agent-1",
    harness: "claude-code",
    cwd: "/Users/dev/project",
    startedAt: "2026-07-27T10:00:00.000Z",
    endedAt: "2026-07-27T11:00:00.000Z",
    turns: [
      {
        index: 1,
        prompt: "wire the retry backoff",
        promptAt: "2026-07-27T10:00:00.000Z",
        toolCalls: [],
        assistantText: "wired it",
        model: null,
        usage: null,
        completedAt: "2026-07-27T10:01:00.000Z",
        incomplete: false,
      },
    ],
    turnCount: 1,
    eventCount: 2,
    reconstructed: true,
    archivedAt: null, // folded from the live event log, not the archive
    limitations: [],
    ...overrides,
  };
}

describe("systemPromptDeliveryFor", () => {
  it("reports launch-flag for both shipped adapters", () => {
    // Both put the generated prompt file in front of the agent themselves
    // (claude's --append-system-prompt, codex's developer_instructions), which
    // is what makes portable continue one code path for the two of them.
    expect(systemPromptDeliveryFor(new ClaudeCodeAdapter())).toBe("launch-flag");
    expect(systemPromptDeliveryFor(new CodexAdapter())).toBe("launch-flag");
  });

  it("falls back to post-ready injection for an adapter that declares nothing", () => {
    // Failing toward "delivered noisily" rather than "silently dropped": an
    // adapter that never wired systemPromptFile would otherwise have its brief
    // written to a file nothing ever reads.
    const undeclared = { id: "codex", eventSource: "hooks" } as unknown as HarnessAdapter;
    expect(systemPromptDeliveryFor(undeclared)).toBe("post-ready-injection");
    expect(systemPromptDeliveryFor(undefined)).toBe("post-ready-injection");
  });
});

describe("buildRehydrationBrief", () => {
  it("renders a labelled brief for a recorded session", async () => {
    const brief = await buildRehydrationBrief("harness-1", {
      readRecord: async () => record(),
      readSummary: async () => null,
    });
    expect(brief).toContain("reconstruction, not restored context");
    expect(brief).toContain("wire the retry backoff");
  });

  it("is null when our event log holds nothing for the id", async () => {
    // The honest answer — it lets the caller say "this continue carried no
    // context" instead of dressing a blank session up as a continuation.
    const brief = await buildRehydrationBrief("never-recorded", {
      readRecord: async () => null,
      readSummary: async () => "should never be read",
    });
    expect(brief).toBeNull();
  });

  it("never throws when the record reader fails", async () => {
    const brief = await buildRehydrationBrief("harness-1", {
      readRecord: async () => Promise.reject(new Error("store on fire")),
      readSummary: async () => null,
    });
    expect(brief).toBeNull();
  });

  it("takes the newest summary when a conversation spans several harness sessions", async () => {
    // A resumed conversation folds several harness sessions into one record,
    // each with its own summary.md. The last one saw the most.
    const readSummary = vi.fn(async (id: string) =>
      id === "harness-2" ? "the later, fuller summary" : "the first segment's summary",
    );
    const brief = await buildRehydrationBrief("harness-1", {
      readRecord: async () => record({ mergedSessionIds: ["harness-1", "harness-2"] }),
      readSummary,
    });
    expect(brief).toContain("the later, fuller summary");
    expect(brief).not.toContain("the first segment's summary");
    expect(readSummary).toHaveBeenCalledWith("harness-2");
  });

  it("falls back to an earlier segment's summary when the newest has none", async () => {
    const brief = await buildRehydrationBrief("harness-1", {
      readRecord: async () => record({ mergedSessionIds: ["harness-1", "harness-2"] }),
      readSummary: async (id) => (id === "harness-1" ? "the only summary there is" : null),
    });
    expect(brief).toContain("the only summary there is");
  });

  it("degrades to the turns alone when a summary read fails", async () => {
    const brief = await buildRehydrationBrief("harness-1", {
      readRecord: async () => record(),
      readSummary: async () => Promise.reject(new Error("unreadable")),
    });
    expect(brief).toContain("wire the retry backoff");
    expect(brief).not.toContain("Rolling summary");
  });

  it("folds in caller-resolved context the record cannot know", async () => {
    const brief = await buildRehydrationBrief("harness-1", {
      readRecord: async () => record(),
      readSummary: async () => null,
      resolveContext: async () => ({
        title: "Retry backoff",
        gitBranch: "feat/SAP-2059",
        workflow: { name: "order-triage", path: "/Users/dev/project/order-triage", definitionId: 188 },
      }),
    });
    expect(brief).toContain("Retry backoff");
    expect(brief).toContain("feat/SAP-2059");
    expect(brief).toContain("definition 188");
  });

  it("honours the caller's token ceiling", async () => {
    const chatty = record({
      turns: Array.from({ length: 30 }, (_, i) => ({
        index: i + 1,
        prompt: `prompt ${i + 1} ${"p".repeat(500)}`,
        promptAt: "2026-07-27T10:00:00.000Z",
        toolCalls: [],
        assistantText: "ok",
        model: null,
        usage: null,
        completedAt: "2026-07-27T10:01:00.000Z",
        incomplete: false,
      })),
    });
    const brief = await buildRehydrationBrief("harness-1", {
      readRecord: async () => chatty,
      readSummary: async () => null,
      maxTokens: 1_000,
    });
    expect(brief!.length).toBeLessThanOrEqual(1_000 * 4);
  });
});
