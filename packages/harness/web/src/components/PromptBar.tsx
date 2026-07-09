/**
 * PromptBar — chat-style text input beneath the terminal pane.
 *
 * Submits via POST /api/sessions/:id/input (the existing injectInput path).
 * Disabled with a visible reason when the session isn't ready (either from
 * the session's own `ready` flag, or reactively after a 409 response).
 *
 * Keyboard contract:
 *   Enter         → submit (when enabled)
 *   Shift+Enter   → newline (no submit)
 *
 * After a successful submit the textarea is cleared and focus stays in the bar
 * so the user can type a follow-up immediately.
 *
 * Draft text is never lost on a failed submit — the 409 reason is surfaced
 * inline, and the bar re-enables once the session becomes ready.
 *
 * Analytics seam: when a submit succeeds, emit a prompt.submitted event here.
 * TODO(SAP-analytics): hook the analytics layer at the `// ANALYTICS_SEAM` comment below.
 */
import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";

import type { HarnessSession } from "@shared/types";

import { ApiError } from "../lib/api";

export interface PromptBarProps {
  /** The active session, or null when no session is selected. */
  session: HarnessSession | null;
  /** Calls POST /api/sessions/:id/input. Must throw ApiError on 409/other errors. */
  onSubmit: (sessionId: string, text: string) => Promise<void>;
}

interface DisabledReason {
  short: string;
  /** Longer hint shown in the inline status row beneath the textarea. */
  detail: string;
}

function readinessReason(session: HarnessSession | null): DisabledReason | null {
  if (!session) return { short: "No active session", detail: "Start or select a session to send input." };
  if (session.status === "exited") return { short: "Session ended", detail: "Resume this session to continue." };
  if (session.status === "starting" || !session.ready) {
    return {
      short: "Session starting",
      detail: "The agent is initialising — input will be available shortly.",
    };
  }
  return null;
}

const MAX_ROWS = 6;

export const PromptBar = ({ session, onSubmit }: PromptBarProps): JSX.Element => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reactiveReason, setReactiveReason] = useState<DisabledReason | null>(null);

  // Proactive readiness gate from the session's own `ready` flag.
  const proactiveReason = readinessReason(session);

  // Reactive reason (from a 409 response) clears as soon as the session
  // becomes ready again so the user can retry without reloading.
  useEffect(() => {
    if (proactiveReason === null && reactiveReason !== null) setReactiveReason(null);
  }, [proactiveReason, reactiveReason]);

  const disabledReason: DisabledReason | null = proactiveReason ?? reactiveReason;
  const isDisabled = disabledReason !== null || submitting;
  const canSubmit = !isDisabled && draft.trim().length > 0;

  // Auto-grow the textarea up to MAX_ROWS: reset first, then let the browser
  // report the natural scrollHeight so a fresh-after-submit always re-collapses.
  const grow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = parseInt(getComputedStyle(el).lineHeight, 10) || 20;
    el.style.height = `${Math.min(el.scrollHeight, lineHeight * MAX_ROWS)}px`;
  }, []);

  useEffect(() => {
    grow();
  }, [draft, grow]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !session) return;
    const text = draft;
    setSubmitting(true);
    try {
      await onSubmit(session.id, text);
      setDraft("");
      setReactiveReason(null);
      // ANALYTICS_SEAM: emit prompt.submitted event here (SAP-analytics).
      // Focus back in the bar for rapid follow-ups.
      textareaRef.current?.focus();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // 409 = session not ready yet — keep the draft, show the reason.
        setReactiveReason({
          short: err.reason ?? "Session not ready",
          detail: err.reason ?? "The session is still initialising. Please try again shortly.",
        });
      } else {
        // Surface other errors as a reactive reason too so the bar never hides
        // a failure silently — the draft remains intact either way.
        setReactiveReason({
          short: "Submit failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, draft, onSubmit, session]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSubmit();
      }
      // Shift+Enter falls through to the textarea's default: it inserts a newline.
    },
    [handleSubmit],
  );

  // Aria disabled string for screen-reader + CSS targeting.
  const ariaDisabled = isDisabled ? "true" : "false";
  const labelId = "prompt-bar-label";
  const statusId = "prompt-bar-status";

  return (
    <div className="prompt-bar" data-disabled={ariaDisabled}>
      <div className="prompt-bar-inner">
        <label id={labelId} className="prompt-bar-label" htmlFor="prompt-bar-textarea">
          Send input to agent
        </label>
        <div className="prompt-bar-row">
          <textarea
            ref={textareaRef}
            id="prompt-bar-textarea"
            className="prompt-bar-textarea"
            aria-labelledby={labelId}
            aria-describedby={disabledReason ? statusId : undefined}
            aria-disabled={ariaDisabled}
            aria-label="Send input to agent"
            placeholder={disabledReason ? disabledReason.short : "Send input to agent… (Enter to submit, Shift+Enter for newline)"}
            value={draft}
            rows={1}
            disabled={isDisabled}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            className="prompt-bar-submit btn-primary"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            aria-disabled={canSubmit ? "false" : "true"}
            aria-label="Submit input"
            data-testid="prompt-bar-submit"
          >
            {submitting ? (
              // Thin spinner arc using a CSS border trick — no extra dependency.
              <span className="prompt-bar-spinner" aria-hidden="true" />
            ) : (
              // Send arrow icon (inline SVG, no external dependency).
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M22 2L11 13" />
                <path d="M22 2L15 22 11 13 2 9l20-7z" />
              </svg>
            )}
          </button>
        </div>

        {disabledReason && (
          <p id={statusId} className="prompt-bar-status" role="status" aria-live="polite" data-testid="prompt-bar-status">
            {disabledReason.detail}
          </p>
        )}
      </div>
    </div>
  );
};
