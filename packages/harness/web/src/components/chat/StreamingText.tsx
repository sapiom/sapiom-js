/**
 * Per-character reveal of an already-complete string (draft1 pattern). Real
 * token streaming is server work on the roadmap; until then the mock
 * script pre-knows its text and this component only presents it.
 *
 * A11y: the full text is exposed via aria-label immediately; the animated
 * slice is aria-hidden so screen readers never hear a word twice. Under
 * prefers-reduced-motion the reveal is instant.
 *
 * States: "streaming" advances and shows the caret; "done" renders the full
 * text; "frozen" holds the reveal exactly where it stopped — this is what
 * makes Stop preserve partial text instead of quietly completing it.
 */
import { useEffect, useState, type JSX } from "react";

export type StreamState = "streaming" | "done" | "frozen";

export interface StreamingTextProps {
  text: string;
  state: StreamState;
  /** ms per character. */
  speed?: number;
}

export const StreamingText = ({ text, state, speed = 13 }: StreamingTextProps): JSX.Element => {
  const [count, setCount] = useState(0);

  // Reset only when the text itself changes — state flips (streaming to
  // frozen) must keep the current position.
  useEffect(() => {
    setCount(0);
  }, [text]);

  useEffect(() => {
    if (state === "done") {
      setCount(text.length);
      return;
    }
    if (state !== "streaming") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setCount(text.length);
      return;
    }
    const timer = setInterval(() => {
      setCount((prev) => {
        if (prev >= text.length) {
          clearInterval(timer);
          return prev;
        }
        return prev + 1;
      });
    }, speed);
    return () => clearInterval(timer);
  }, [state, text, speed]);

  const complete = state === "done" || count >= text.length;
  return (
    <span className="chat-streaming" aria-label={text}>
      <span aria-hidden="true">{text.slice(0, count)}</span>
      {state === "streaming" && !complete && (
        <span className="chat-streaming-caret" aria-hidden="true">
          ▍
        </span>
      )}
    </span>
  );
};
