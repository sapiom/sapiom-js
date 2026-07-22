/**
 * Chat feed: role="log" live region with the draft1 anatomy — user bubble,
 * assistant row (mark + copy column), indented system card — plus the
 * near-bottom-aware autoscroll. When the user has scrolled up, new items
 * surface a floating "new events" pill instead of yanking the view; a
 * ResizeObserver keeps the view pinned while streamed text grows.
 *
 * Sequencing contract (industry order): user bubble → thinking card first →
 * tool cards in execution order → the assistant verdict streams LAST →
 * receipt/system card. The pending "Studio is working" row may only render
 * while NOTHING else is actively streaming — it narrates gaps, never talks
 * over content that is already moving.
 */
import { useEffect, useRef, useState, type JSX } from "react";

import type { FeedItem } from "../../lib/chat-types";
import { EmptyState } from "../EmptyState";
import { Icon } from "../Icon";
import { FeedAttachment } from "./FeedCard";
import { StarterPills } from "./StarterPills";
import { StreamingText } from "./StreamingText";

/** Within this distance of the bottom the view still counts as pinned. */
const PIN_THRESHOLD_PX = 140;
/** Reaching this close to the bottom clears the new-events counter. */
const CLEAR_THRESHOLD_PX = 100;

const FeedRow = ({ item }: { item: FeedItem }): JSX.Element => {
  if (item.role === "user") {
    // No timestamp row: "Now" under every bubble was noise that aged into a
    // lie on re-read. Provenance stays on system rows, where it means something.
    return (
      <li className="chat-user" data-item-id={item.id}>
        <p>{item.body}</p>
      </li>
    );
  }
  if (item.role === "system") {
    const tone = item.tone ?? "default";
    const iconName = tone === "warning" ? "TriangleAlert" : tone === "success" ? "Check" : "Info";
    return (
      <li className={`chat-system is-${tone}`} data-item-id={item.id}>
        <span className="chat-system-icon">
          <Icon name={iconName} size={14} />
        </span>
        <div className="chat-system-body">
          {item.title && <strong>{item.title}</strong>}
          <p>{item.body}</p>
          {/* Receipt facts (duration, cost, …): the same mono chip recipe
              assistant rows use — real data points, honestly absent when
              nothing was measured. */}
          {item.chips && item.chips.length > 0 && (
            <div className="chat-chips">
              {item.chips.map((chip) => (
                <span key={chip}>{chip}</span>
              ))}
            </div>
          )}
          {item.meta && <span>{item.meta}</span>}
        </div>
      </li>
    );
  }
  // Assistant prose goes full measure — role is carried by typography (the
  // user's inverted bubble is the only boxed voice), not by a gutter mark.
  return (
    <li className="chat-assistant" data-item-id={item.id}>
      <div className="chat-assistant-copy">
        {item.title && <h3>{item.title}</h3>}
        {item.body.length > 0 && (
          <p>
            {item.streaming || item.interrupted ? (
              <StreamingText text={item.body} state={item.streaming ? "streaming" : "frozen"} />
            ) : (
              item.body
            )}
          </p>
        )}
        {item.card && <FeedAttachment card={item.card} />}
        {item.chips && item.chips.length > 0 && (
          <div className="chat-chips">
            {item.chips.map((chip) => (
              <span key={chip}>{chip}</span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
};

const PendingRow = ({ stage }: { stage: string }): JSX.Element => (
  <li className="chat-pending" data-testid="chat-pending">
    {/* The spinner rides INSIDE the title line — no gutter mark floating
        beside the column (those read as debris, not structure). */}
    <strong className="chat-pending-title">
      <span className="chat-pending-spin" aria-hidden="true">
        <Icon name="RefreshCw" size={13} />
      </span>
      Studio is working
    </strong>
    <p>{stage}</p>
    <span className="chat-progress-track" aria-hidden="true">
      <span />
    </span>
  </li>
);

/** True while any row is visibly producing content — streamed prose, a live
 *  thinking card, or a tool call waiting on its result. */
function anyStreaming(items: FeedItem[]): boolean {
  return items.some(
    (item) =>
      item.streaming === true ||
      (item.card?.kind === "thinking" && item.card.live === true) ||
      (item.card?.kind === "tool" && item.card.running === true),
  );
}

export interface ChatFeedProps {
  items: FeedItem[];
  pendingStage: string | null;
  /** Starter pills — submit the prefilled ask. */
  onStarter(text: string): void;
}

export const ChatFeed = ({ items, pendingStage, onStarter }: ChatFeedProps): JSX.Element => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Pinned = user is near the bottom; tracked in a ref because the
  // ResizeObserver callback must read the latest value without re-observing.
  const pinnedRef = useRef(true);
  const [newEvents, setNewEvents] = useState(0);
  // The pending row narrates gaps only: while any row streams, the moving
  // content is the status and the extra row below it would be noise.
  const showPending = pendingStage !== null && !anyStreaming(items);
  const rowCount = items.length + (showPending ? 1 : 0);
  const prevCountRef = useRef(rowCount);
  const empty = items.length === 0 && pendingStage === null;

  const scrollToBottom = (behavior: ScrollBehavior): void => {
    const el = scrollRef.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : behavior });
  };

  // New rows: follow when pinned, count when the user has scrolled away.
  useEffect(() => {
    const grew = rowCount > prevCountRef.current;
    prevCountRef.current = rowCount;
    if (!grew) return;
    if (pinnedRef.current) scrollToBottom("smooth");
    else setNewEvents((n) => n + 1);
  }, [rowCount]);

  // Streamed text grows without changing the row count — keep the view
  // pinned to the bottom while it does. Depends on `empty` because the
  // scroller only mounts once the empty state gives way to the feed.
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (empty || !content || !el) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [empty]);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distance < PIN_THRESHOLD_PX;
    if (distance < CLEAR_THRESHOLD_PX) setNewEvents(0);
  };

  if (items.length === 0 && !pendingStage) {
    return (
      <div className="chat-feed-region">
        <EmptyState
          className="chat-empty"
          eyebrow="Session agent"
          title="What should this workspace do?"
          body="Describe the outcome. Studio maps the workflow first, so you see every step before anything runs."
        >
          <StarterPills onPick={onStarter} />
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="chat-feed-region">
      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll} data-testid="chat-scroll">
        <div className="chat-scroll-inner" ref={contentRef}>
          <ol className="chat-feed" role="log" aria-live="polite" aria-relevant="additions text">
            {items.map((item) => (
              <FeedRow key={item.id} item={item} />
            ))}
            {showPending && <PendingRow stage={pendingStage} />}
          </ol>
        </div>
      </div>
      {newEvents > 0 && (
        <button
          type="button"
          className="chat-new-events"
          data-testid="chat-new-events"
          onClick={() => {
            setNewEvents(0);
            pinnedRef.current = true;
            scrollToBottom("smooth");
          }}
        >
          {newEvents === 1 ? "1 new event" : `${newEvents} new events`}
          <Icon name="ArrowDown" size={13} />
        </button>
      )}
    </div>
  );
};
