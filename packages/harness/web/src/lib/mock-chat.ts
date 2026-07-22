/**
 * Scripted demo conversation for mock mode (VITE_MOCK=1) — the reference
 * implementation of the agent's voice: verdict first in the prose, no
 * throat-clearing, no exclamation marks.
 *
 * Sequencing contract (industry order, matching what real harnesses emit):
 *   1. the THINKING card streams first — open, elapsed seconds counting,
 *      collapsing to "Thought for Ns" + a one-line summary when it settles;
 *   2. TOOL cards land in execution order, appearing when the call starts
 *      and settling in place when the result arrives;
 *   3. the assistant VERDICT text streams LAST;
 *   4. the receipt/system card closes the turn.
 * The engine mirrors draft1's startMappingSequence: stage-by-stage appends
 * with AbortController-aware waits, clamped under prefers-reduced-motion so
 * the demo stays quick for those users.
 */
import type { FeedItem } from "./chat-types";

/** StreamingText reveal rate — mock-chat waits are derived from it so the
 *  orchestrator's streaming flag flips right as the reveal completes. */
export const STREAM_MS_PER_CHAR = 13;

/** Reduced-motion waits clamp to this ceiling (draft1's scheduler value). */
const REDUCED_MOTION_WAIT_MS = 160;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface ChatScriptHandlers {
  append(item: FeedItem): void;
  patch(id: string, patch: Partial<FeedItem>): void;
  /** Drives the pending row's stage line; null hides the row. */
  setStage(stage: string | null): void;
}

/** Abort-aware sleep. Resolves early (never rejects) on abort — callers
 *  check signal.aborted after each await, matching draft1's scheduler. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  const clamped = prefersReducedMotion() ? Math.min(ms, REDUCED_MOTION_WAIT_MS) : ms;
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, clamped);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

/** How long StreamingText needs for `text`, plus a settle margin (draft1). */
function streamTime(text: string): number {
  return text.length * STREAM_MS_PER_CHAR + 420;
}

/** Exported for the e2e suite: the stop test asserts the frozen partial text
 *  is strictly shorter than this full body. Verdict first, one next action
 *  last — the whole turn's prose in a single message. */
export const MAPPING_VERDICT_BODY =
  "The leasing workflow is a four step pipeline with two clean exits. Intake feeds screening, screening feeds the credit check, and approval routing splits on the score: 620 and above drafts a lease, anything lower goes to manual review.\n\nNext action: dry run the pipeline on the three most recent applications to watch the routing decide with real records.";

/** Exported for the e2e suite: the thinking card expands to exactly this. */
export const MAPPING_THINKING_TEXT =
  "The workspace declares one workflow, leasing, with application intake as the only entry point. Screening and credit check have to stay sequential because the credit check reads the screening score. Approval routing branches on that score: 620 and above drafts a lease, everything else escalates to a person. Both ends of the graph are marked terminal, so the map has no dangling states. Nothing in this pass calls a capability, so mapping stays read only.";

/** The prompt the demo opens on — the mapping conversation answers it. */
export const DEMO_MAP_PROMPT = "Map the leasing workflow before anything runs.";

// Step names here are the SAME slugs the canvas graph and Steps tab use
// (intake, screen, credit-check, approve?, draft-lease, manual-review) —
// one vocabulary across chat, canvas, and steps, no hidden mapping.
const TOOL_OUTPUT = [
  "leasing.workflow",
  "  entry         intake",
  "  steps         4 typed",
  "  exits         draft-lease, manual-review",
  "  capabilities  records.read, credit.check, rules.evaluate, records.write",
  "  drift         none against the drawn map",
].join("\n");

/** The step-map card's steps — shared by the streamed script and the seeded
 *  settled feed so the two can never drift. */
const MAPPING_STEPS = [
  { id: "step-intake", label: "intake", capability: "records.read", status: "done" as const },
  { id: "step-screening", label: "screen", capability: "records.read", status: "done" as const },
  { id: "step-credit", label: "credit-check", capability: "credit.check", status: "done" as const },
  { id: "step-routing", label: "approve?", capability: "rules.evaluate", status: "done" as const },
  { id: "step-draft", label: "draft-lease", capability: "records.write", status: "done" as const },
  { id: "step-review", label: "manual-review", capability: "records.write", status: "done" as const },
];

/** First turn: thinking streams first, the tool and step-map cards land in
 *  execution order, the verdict prose streams last, the receipt closes. */
export async function runMappingScript(h: ChatScriptHandlers, signal: AbortSignal): Promise<void> {
  h.setStage("Reading the workspace");
  await wait(600, signal);
  if (signal.aborted) return;

  // 1 — Thinking, live: open card, elapsed counter, reasoning streaming.
  const thinkStart = Date.now();
  h.append({
    id: "map-thinking",
    role: "assistant",
    body: "",
    card: {
      kind: "thinking",
      live: true,
      seconds: 0,
      summary: "",
      text: MAPPING_THINKING_TEXT,
    },
  });
  await wait(streamTime(MAPPING_THINKING_TEXT), signal);
  if (signal.aborted) return;
  h.patch("map-thinking", {
    card: {
      kind: "thinking",
      live: false,
      seconds: Math.max(1, Math.round((Date.now() - thinkStart) / 1000)),
      summary: "Traced intake through both terminal outcomes",
      text: MAPPING_THINKING_TEXT,
    },
  });
  h.setStage("Confirming the graph against sapiom.json");
  await wait(600, signal);
  if (signal.aborted) return;

  // 2 — Tool call, in execution order: appears when it starts…
  h.append({
    id: "map-source",
    role: "assistant",
    body: "",
    card: {
      kind: "tool",
      running: true,
      name: "read sapiom.json",
      summary: "Checking the drawn map against the source",
      output: "",
    },
  });
  await wait(900, signal);
  if (signal.aborted) return;
  // …and settles in place when the result lands.
  h.patch("map-source", {
    card: {
      kind: "tool",
      running: false,
      name: "read sapiom.json",
      summary: "4 steps, 2 exits, no drift",
      output: TOOL_OUTPUT,
    },
  });
  h.setStage("Drawing the step map");
  await wait(600, signal);
  if (signal.aborted) return;

  // 3 — The step map, same execution-order contract as the tool card.
  h.append({
    id: "map-steps",
    role: "assistant",
    body: "",
    chips: ["4 typed steps", "2 exits", "read only"],
    card: {
      kind: "steps",
      label: "Leasing intake map",
      // The same slugs the canvas graph and Steps tab render — the chat's
      // step list must be recognizable there without a mental mapping.
      steps: MAPPING_STEPS,
    },
  });
  h.setStage("Validating terminal states");
  await wait(700, signal);
  if (signal.aborted) return;

  // 4 — The verdict streams LAST: state change first, one next action.
  h.append({
    id: "map-verdict",
    role: "assistant",
    title: "Mapped: leasing, 4 steps and 2 exits",
    body: MAPPING_VERDICT_BODY,
    streaming: true,
  });
  // The verdict is the last act — a stage line under it would be stale
  // narration, so the caret alone signals the remaining activity.
  h.setStage(null);
  await wait(streamTime(MAPPING_VERDICT_BODY), signal);
  if (signal.aborted) return;
  h.patch("map-verdict", { streaming: false });
  await wait(500, signal);
  if (signal.aborted) return;

  // 5 — Receipt: the turn's durable fact, after the prose has settled.
  h.append({
    id: "map-validated",
    role: "system",
    tone: "success",
    title: "Map matches the source",
    body: "Both terminal states are reachable and no step is orphaned. The mapping pass stayed read only.",
    meta: "map · read only",
  });
  h.setStage(null);
}

/** Exported for the e2e suite: the local-test turn's verdict, verbatim. */
export const LOCAL_TEST_VERDICT_BODY =
  "Local test passed. Every capability was stubbed, so nothing was called: intake, screening, the credit check, and approval routing all ran against fixtures. This proves the wiring, not the data.\n\nNext action: run it on prod when you want the pipeline to touch real records.";

/**
 * "Run a local test": an honest local run turn. The tool card shows the
 * stubbed run — every capability runs against fixtures, so nothing is called.
 */
export async function runLocalTestScript(h: ChatScriptHandlers, signal: AbortSignal): Promise<void> {
  h.setStage("Stubbing every capability");
  await wait(600, signal);
  if (signal.aborted) return;

  const toolId = `local-tool-${Date.now()}`;
  h.append({
    id: toolId,
    role: "assistant",
    body: "",
    card: {
      kind: "tool",
      running: true,
      name: "sapiom agents run --target local",
      summary: "Running the pipeline with stubbed capabilities",
      output: "",
    },
  });
  await wait(900, signal);
  if (signal.aborted) return;
  // Settle the running tool card in place.
  h.patch(toolId, {
    card: {
      kind: "tool",
      running: false,
      name: "sapiom agents run --target local",
      summary: "4 steps passed, capabilities stubbed",
      output: ["leasing.run  target=local", "  steps    4 passed", "  stubs    every capability"].join("\n"),
    },
  });
  h.setStage("Reading the stubbed results");
  await wait(500, signal);
  if (signal.aborted) return;

  const verdictId = `local-verdict-${Date.now()}`;
  h.append({
    id: verdictId,
    role: "assistant",
    title: "Local test passed",
    body: LOCAL_TEST_VERDICT_BODY,
    chips: ["4 steps", "stubbed"],
    streaming: true,
  });
  h.setStage(null);
  await wait(streamTime(LOCAL_TEST_VERDICT_BODY), signal);
  if (signal.aborted) return;
  h.patch(verdictId, { streaming: false });
  await wait(400, signal);
  if (signal.aborted) return;
  h.append({
    id: `local-receipt-${Date.now()}`,
    role: "system",
    tone: "success",
    title: "Local test passed",
    body: "Every capability ran against a stub, so nothing was called. This proves the wiring; per-step latency and pass/fail are on the Steps tab.",
    meta: "local · stubbed",
  });
  h.setStage(null);
}

/**
 * The mapping conversation as SETTLED feed items — the exact end-state
 * runMappingScript arrives at. Seeded as the demo session's initial feed so it
 * is populated on load without a click and without a streaming script that a
 * StrictMode remount (or a session switch) could abort mid-flight. One source
 * of truth (MAPPING_STEPS/TOOL_OUTPUT/MAPPING_*_TEXT) backs both paths.
 */
export function seededMappingFeed(): FeedItem[] {
  return [
    { id: "map-user", role: "user", body: DEMO_MAP_PROMPT },
    {
      id: "map-thinking",
      role: "assistant",
      body: "",
      card: {
        kind: "thinking",
        live: false,
        seconds: 7,
        summary: "Traced intake through both terminal outcomes",
        text: MAPPING_THINKING_TEXT,
      },
    },
    {
      id: "map-source",
      role: "assistant",
      body: "",
      card: {
        kind: "tool",
        running: false,
        name: "read sapiom.json",
        summary: "4 steps, 2 exits, no drift",
        output: TOOL_OUTPUT,
      },
    },
    {
      id: "map-steps",
      role: "assistant",
      body: "",
      chips: ["4 typed steps", "2 exits", "read only"],
      card: { kind: "steps", label: "Leasing intake map", steps: MAPPING_STEPS },
    },
    {
      id: "map-verdict",
      role: "assistant",
      title: "Mapped: leasing, 4 steps and 2 exits",
      body: MAPPING_VERDICT_BODY,
      streaming: false,
    },
    {
      id: "map-validated",
      role: "system",
      tone: "success",
      title: "Map matches the source",
      body: "Both terminal states are reachable and no step is orphaned. The mapping pass stayed read only.",
      meta: "map · read only",
    },
  ];
}

const FOLLOW_UP_BODY =
  "The map above stays accurate to sapiom.json as of the last pass. Try one of the starter prompts to run a local test, or run prod when you want the pipeline to touch real records.";

/** Later turns with no dedicated script: an honest, short reply that points at
 *  the moves that DO respond, never faking a run. */
export async function runFollowUpScript(h: ChatScriptHandlers, signal: AbortSignal): Promise<void> {
  h.setStage("Checking what the demo can do");
  await wait(700, signal);
  if (signal.aborted) return;

  const id = `follow-${Date.now()}`;
  h.append({ id, role: "assistant", body: FOLLOW_UP_BODY, streaming: true });
  h.setStage(null);
  await wait(streamTime(FOLLOW_UP_BODY), signal);
  if (signal.aborted) return;
  h.patch(id, { streaming: false });
  h.setStage(null);
}

/**
 * Routes a submitted prompt to the right scripted turn by intent. Map intent
 * (and the auto-played first turn) draws the step map; the local-test starter
 * pill gets a dedicated honest turn; everything else gets the generic reply.
 */
export function pickChatScript(
  text: string,
): (h: ChatScriptHandlers, signal: AbortSignal) => Promise<void> {
  const t = text.toLowerCase();
  if (t.includes("map")) return runMappingScript;
  if (t.includes("local")) return runLocalTestScript;
  return runFollowUpScript;
}
