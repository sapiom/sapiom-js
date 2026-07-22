/**
 * Chat feed data model (chat surface of the session pane).
 *
 * Ported from the draft1 FeedItem contract and extended with two disclosure
 * card kinds: "thinking" (chain of thought behind a compact "Thought for Ns"
 * row) and "tool" (a tool call's one-line result that expands to its raw
 * output). A message carries AT MOST one card — richer turns are expressed
 * as several feed items, which keeps every row scannable and the log linear
 * for assistive tech.
 */

export type FeedRole = "user" | "assistant" | "system";

/** System-row accent. Tones tint the icon only — color is never the sole
 *  signal, the title always carries the message. */
export type FeedTone = "default" | "success" | "warning";

/** One row of a "steps" card — a compact projection of the workflow map. */
export interface ChatStep {
  id: string;
  label: string;
  /** Typed capability code, rendered mono ("records.read"). */
  capability?: string;
  status: "done" | "active" | "pending";
}

export type FeedCardData =
  | {
      kind: "thinking";
      /** Whole seconds; drives the collapsed "Thought for Ns" row. */
      seconds: number;
      /** One-line gist shown while collapsed. */
      summary: string;
      /** Full reasoning revealed on expand. */
      text: string;
      /** True while the reasoning is still streaming: the card renders open
       *  with a live elapsed counter ("Thinking…"), then collapses to
       *  "Thought for Ns" when this flips off. */
      live?: boolean;
    }
  | {
      kind: "tool";
      /** Mono tool invocation ("read sapiom.json"). */
      name: string;
      /** One-line result shown while collapsed. */
      summary: string;
      /** Raw output revealed on expand — preformatted, mono. */
      output: string;
      /** True from the call starting until its result lands — the card
       *  appears when the tool starts and settles in place (execution
       *  order stays visible in the feed). */
      running?: boolean;
    }
  | {
      kind: "steps";
      label: string;
      steps: ChatStep[];
    };

export interface FeedItem {
  id: string;
  role: FeedRole;
  /** Optional bold heading (assistant and system rows). */
  title?: string;
  /** Plain text only — this surface renders no markdown. Card-only rows
   *  (a thinking or tool card with no prose) carry an empty string. */
  body: string;
  /** Mono provenance line ("map · read only"). Never a bare timestamp. */
  meta?: string;
  /** Status pills under the body. */
  chips?: string[];
  tone?: FeedTone;
  /** True while the orchestrator is revealing the body via StreamingText. */
  streaming?: boolean;
  /** True when a stop froze this message mid-reveal — the partial text is
   *  preserved exactly as revealed, never completed after the fact. */
  interrupted?: boolean;
  /** At most one attachment card per message. */
  card?: FeedCardData;
}
