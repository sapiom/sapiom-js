/**
 * Progressive-disclosure card (ported from draft1's CollapsibleFeedCard).
 * The whole header is ONE button (icon + title + one-line summary + chevron)
 * so the touch target spans the full row. Content stays UNMOUNTED while
 * closed — thinking text and tool output can be long, and never rendering
 * them keeps the live-region log light for screen readers and the scroller.
 *
 * Sequencing contract: the thinking card streams FIRST in a turn — open,
 * "Thinking…" with a live elapsed counter — and collapses to "Thought for
 * Ns" + a one-line summary when the reasoning settles. Tool cards appear
 * when the call starts and settle in place when its result lands.
 */
import { useEffect, useId, useState, type JSX, type ReactNode } from "react";

import type { ChatStep, FeedCardData } from "../../lib/chat-types";
import { Icon } from "../Icon";
import { StreamingText } from "./StreamingText";

interface FeedCardProps {
  icon: string;
  title: string;
  summary: string;
  /** Tool invocations read as code — render the title mono. */
  monoTitle?: boolean;
  defaultOpen?: boolean;
  /** Controlled open (the live thinking card holds itself open while it
   *  streams); omit for the default uncontrolled disclosure. */
  open?: boolean;
  onToggle?: () => void;
  testId?: string;
  children: ReactNode;
}

export const FeedCard = ({
  icon,
  title,
  summary,
  monoTitle,
  defaultOpen = false,
  open: openProp,
  onToggle,
  testId,
  children,
}: FeedCardProps): JSX.Element => {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const contentId = useId();
  return (
    <section className="chat-card" data-testid={testId}>
      <button
        type="button"
        className="chat-card-header"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => (onToggle ? onToggle() : setOpenState((prev) => !prev))}
      >
        <span className="chat-card-icon">
          <Icon name={icon} size={14} />
        </span>
        <span className="chat-card-copy">
          <strong className={monoTitle ? "chat-card-title-mono" : undefined}>{title}</strong>
          <small>{summary}</small>
        </span>
        {/* Disclosure caret contract: down closed, rotated 180 to up open
            (the rotation lives on .chat-card-chevron via aria-expanded). */}
        <span className="chat-card-chevron" aria-hidden="true">
          <Icon name="ChevronDown" size={14} />
        </span>
      </button>
      {open && (
        <div className="chat-card-content" id={contentId}>
          {children}
        </div>
      )}
    </section>
  );
};

/** The thinking card's two lives: streaming (open, elapsed counter ticking)
 *  and settled ("Thought for Ns" + summary, collapsed until asked). */
const ThinkingAttachment = ({ card }: { card: Extract<FeedCardData, { kind: "thinking" }> }): JSX.Element => {
  const live = card.live === true;
  // null = follow the live phase (open while streaming, closed once done);
  // a click takes over and pins the user's choice.
  const [pinnedOpen, setPinnedOpen] = useState<boolean | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  const open = pinnedOpen ?? live;
  return (
    <FeedCard
      icon="Brain"
      title={live ? `Thinking… ${elapsed}s` : `Thought for ${card.seconds}s`}
      summary={live ? "Reasoning streams below until the verdict is ready" : card.summary}
      open={open}
      onToggle={() => setPinnedOpen(!open)}
      testId="chat-card-thinking"
    >
      <p className="chat-card-thinking">
        {live ? <StreamingText text={card.text} state="streaming" /> : card.text}
      </p>
    </FeedCard>
  );
};

function stepsSummary(steps: ChatStep[]): string {
  const active = steps.filter((step) => step.status === "active").length;
  return `${steps.length} typed steps${active > 0 ? ` · ${active} active` : ""}`;
}

/** Maps a FeedItem's card union onto the disclosure shell. */
export const FeedAttachment = ({ card }: { card: FeedCardData }): JSX.Element => {
  if (card.kind === "thinking") {
    return <ThinkingAttachment card={card} />;
  }
  if (card.kind === "tool") {
    return (
      <FeedCard icon="SquareTerminal" title={card.name} monoTitle summary={card.summary} testId="chat-card-tool">
        {card.running ? (
          <p className="chat-card-thinking">Waiting for the result…</p>
        ) : (
          <pre className="chat-card-output">{card.output}</pre>
        )}
      </FeedCard>
    );
  }
  return (
    <FeedCard icon="ListChecks" title={card.label} summary={stepsSummary(card.steps)} defaultOpen testId="chat-card-steps">
      <ol className="chat-card-steps">
        {card.steps.map((step, index) => (
          <li key={step.id} data-status={step.status}>
            <span className="chat-step-index" aria-hidden="true">
              {index + 1}
            </span>
            <span className="chat-step-label">{step.label}</span>
            {step.capability && <code className="chat-step-capability">{step.capability}</code>}
          </li>
        ))}
      </ol>
    </FeedCard>
  );
};
