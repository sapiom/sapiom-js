/**
 * Chat orchestrator for the session pane. Mock mode runs the scripted
 * mapping conversation client-side; live mode is honest about its limits:
 * the prompt goes to the real session pty (injectInput) and a system note
 * says where the output actually streams, because the headless chat engine
 * is server work on the roadmap — no fake live streaming here.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { HarnessEntry, HarnessKind, MacroDef } from "@shared/types";

import type { SkillMeta } from "../../lib/api";
import type { FeedItem } from "../../lib/chat-types";
import { pickChatScript, seededMappingFeed } from "../../lib/mock-chat";
import { runCostLabel } from "../../lib/run-cost";
import type { ObservedRun } from "../../lib/use-harness-state";
import { ChatFeed } from "./ChatFeed";
import { Composer } from "./Composer";
import { StarterPills } from "./StarterPills";

/** Honest run duration: the sum of the step latencies the RunView actually
 *  recorded — null (absent) when no step carried one. */
function runDurationLabel(run: ObservedRun["run"]): string | null {
  let ms = 0;
  let measured = false;
  for (const step of run.steps) {
    if (step.latencyMs !== undefined) {
      ms += step.latencyMs;
      measured = true;
    }
  }
  if (!measured) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export interface ChatPaneProps {
  /** True when a real harness server backs this session. */
  live: boolean;
  /** Live mode only: submit the prompt to the session pty. */
  onInject(text: string): Promise<void>;
  /** The session's pinned agent — the composer names it as a static label. */
  harness: HarnessKind;
  /** Real macro registry — the composer's library offers inject-kind macros
   *  as insertable prompt templates. */
  macros: MacroDef[];
  /** Real skills fetch — same source the Skills tab reads. */
  listSkills(): Promise<SkillMeta[]>;
  /** Adapter registry fetch — the composer's provider dropdown reads it. */
  listHarnesses?(): Promise<HarnessEntry[]>;
  /** Every run observed for THIS session, oldest first — a run reaching a
   *  terminal state lands a receipt in the feed with its real status,
   *  duration, and cost (honest absence for anything unmeasured). */
  runs?: ObservedRun[];
  /** Demo seed (mock mode): open the demo session on the SETTLED mapping
   *  conversation, so the feed is populated on load without a click. Seeded as
   *  initial state (not a streamed script) so a StrictMode remount or a
   *  session switch can never leave it half-drawn. */
  autoStartScript?: boolean;
}

export const ChatPane = ({
  live,
  onInject,
  harness,
  macros,
  listSkills,
  listHarnesses,
  runs,
  autoStartScript = false,
}: ChatPaneProps): JSX.Element => {
  // Demo session opens on the settled mapping conversation; every other
  // session (and ?seed=0) starts blank and submit-driven.
  const [items, setItems] = useState<FeedItem[]>(() => (autoStartScript ? seededMappingFeed() : []));
  const [stage, setStage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  // When the current turn started — a stop mid-thinking needs the honest
  // elapsed figure for the frozen "Thought for Ns" row.
  const turnStartRef = useRef(0);

  const append = useCallback((item: FeedItem) => setItems((prev) => [...prev, item]), []);
  const patch = useCallback(
    (id: string, delta: Partial<FeedItem>) =>
      setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...delta } : item))),
    [],
  );

  // A script must never outlive the pane (session switch unmounts it).
  useEffect(() => () => controllerRef.current?.abort(), []);

  // Run receipts (7c): when an observed run reaches a terminal state while
  // this pane is mounted, a system receipt lands in the feed carrying the
  // RunView's REAL facts — status (tone + title), duration, cost — with
  // honest absence for anything unmeasured. Runs already terminal at mount
  // are seeded as seen: the feed receipts new completions, it doesn't
  // backfill history (the Steps tab and run picker hold the archive).
  const receiptedRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!runs) return;
    const terminal = runs.filter((observed) => observed.run.status !== "running");
    if (receiptedRef.current === null) {
      receiptedRef.current = new Set(terminal.map((observed) => observed.run.executionId));
      return;
    }
    const seen = receiptedRef.current;
    for (const observed of terminal) {
      const { run, target } = observed;
      if (seen.has(run.executionId)) continue;
      seen.add(run.executionId);
      const failed = run.status !== "completed";
      const duration = runDurationLabel(run);
      const cost = runCostLabel(run, target);
      const chips = [
        `${run.steps.length} ${run.steps.length === 1 ? "step" : "steps"}`,
        ...(duration ? [duration] : []),
        ...(cost ? [cost] : []),
      ];
      append({
        id: `run-${run.executionId}`,
        role: "system",
        tone: failed ? "warning" : "success",
        title: `Run ${run.status}`,
        body: failed
          ? "The run ended without completing. Per-step detail is on the Steps tab."
          : "Every step settled. Per-step latency and cost are on the Steps tab.",
        chips,
        meta: `${target} run · ${run.executionId}`,
      });
    }
  }, [runs, append]);

  const submit = (text: string): void => {
    append({ id: `user-${Date.now()}`, role: "user", body: text });
    setDraft("");

    if (live) {
      void onInject(text).then(
        () =>
          append({
            id: `sent-${Date.now()}`,
            role: "system",
            body: "Sent to the session agent. Output streams in Terminal until chat streaming lands server-side.",
            meta: "live · pty",
          }),
        (err: unknown) =>
          append({
            id: `send-failed-${Date.now()}`,
            role: "system",
            tone: "warning",
            title: "Send failed",
            body: `The session did not take the prompt: ${(err as Error).message}. Wait for the prompt in Terminal to be ready, then resend.`,
          }),
      );
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setPending(true);
    turnStartRef.current = Date.now();
    // Route by intent: the map draws the step map; the demo starter pills get
    // their own honest turns; everything else the generic reply (mock-chat.ts).
    const script = pickChatScript(text);
    void script({ append, patch, setStage }, controller.signal).finally(() => {
      // A stop already settled the UI; only a natural finish clears it here.
      if (!controller.signal.aborted) {
        setPending(false);
        setStage(null);
      }
    });
  };

  const stop = (): void => {
    controllerRef.current?.abort();
    const elapsedS = Math.max(1, Math.round((Date.now() - turnStartRef.current) / 1000));
    // Freeze, never complete: interrupted keeps StreamingText at the exact
    // character the reveal reached when the user said stop. Live cards
    // settle the same way — the thinking card collapses with the honest
    // elapsed time, a running tool card reports it never finished.
    setItems((prev) =>
      prev.map((item) => {
        let next = item;
        if (item.streaming) next = { ...next, streaming: false, interrupted: true };
        if (item.card?.kind === "thinking" && item.card.live) {
          next = {
            ...next,
            card: { ...item.card, live: false, seconds: elapsedS, summary: "Interrupted before the verdict" },
          };
        }
        if (item.card?.kind === "tool" && item.card.running) {
          next = {
            ...next,
            card: { ...item.card, running: false, summary: "Stopped before the result", output: "(no result: the call was stopped)" },
          };
        }
        return next;
      }),
    );
    append({
      id: `stopped-${Date.now()}`,
      role: "system",
      tone: "warning",
      title: "Drafting stopped",
      body: "Partial draft preserved. Nothing ran and nothing was charged.",
      meta: "stopped · no side effects",
    });
    setStage(null);
    setPending(false);
  };

  // A settled turn re-offers the starter pills right above the composer —
  // the next likely asks, one tap away, without burying the conversation.
  const settled = items.length > 0 && !pending;

  return (
    <section className="chat-pane" data-testid="chat-pane">
      <ChatFeed
        items={items}
        pendingStage={stage}
        onStarter={(text) => {
          if (!pending) submit(text);
        }}
      />
      {settled && (
        <div className="chat-followups" data-testid="chat-followups">
          <StarterPills onPick={(text) => submit(text)} />
        </div>
      )}
      <Composer
        value={draft}
        pending={pending}
        harness={harness}
        macros={macros}
        listSkills={listSkills}
        listHarnesses={listHarnesses}
        onChange={setDraft}
        onSubmit={submit}
        onStop={stop}
      />
    </section>
  );
};
