/**
 * PromptBar — chat-style text input beneath the terminal pane.
 *
 * Submits via POST /api/sessions/:id/input (the existing injectInput path).
 *
 * TWO-TIER READINESS SEMANTICS
 * ─────────────────────────────
 * proactiveReason  — derived from session.ready / session.status. Gates the
 *   textarea (disabled=true) and the submit button. Clears automatically when
 *   the session becomes ready via the event bus.
 *
 * reactiveReason   — set when a submit attempt fails (409 / network error).
 *   INFORMS the user (shown in the status line, placeholder) but does NOT
 *   disable the bar. The user can read the message and retry immediately.
 *   Clears on: successful submit, first keystroke after the error, or the
 *   not-ready→ready proactive transition (belt-and-suspenders cleanup).
 *
 * This separation avoids the deadlock where a 409 arriving while the session
 * is proactively ready would permanently lock the bar: reactive can never
 * disable (so canSubmit stays true), and the user can always retry.
 *
 * Keyboard contract:
 *   Enter         → submit (when canSubmit)
 *   Shift+Enter   → newline (no submit)
 *   Any keystroke → clears a stale reactiveReason (acknowledged by the edit)
 *
 * Draft text is per-session: switching tabs preserves each session's own
 * half-typed text; no cross-session leakage.
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

interface StatusReason {
  short: string;
  /** Longer hint shown in the inline status line beneath the textarea. */
  detail: string;
}

function readinessReason(session: HarnessSession | null): StatusReason | null {
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

  // Per-session draft storage: switching tabs preserves each session's own
  // half-typed text without leaking into neighbouring sessions.
  const draftsRef = useRef<Map<string, string>>(new Map());
  const prevSessionIdRef = useRef<string | null>(session?.id ?? null);
  const [draft, setDraft] = useState<string>(() => {
    return session ? (draftsRef.current.get(session.id) ?? "") : "";
  });

  // When the active session changes: persist the outgoing draft and restore
  // the incoming session's own draft (empty if never typed in).
  useEffect(() => {
    const incoming = session?.id ?? null;
    const outgoing = prevSessionIdRef.current;
    if (incoming === outgoing) return;
    if (outgoing !== null) {
      draftsRef.current.set(outgoing, draft);
    }
    prevSessionIdRef.current = incoming;
    setDraft(incoming !== null ? (draftsRef.current.get(incoming) ?? "") : "");
  // `draft` is intentionally omitted from the dep array: the effect is keyed
  // on session changes only; the early-exit guard prevents spurious runs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  const [submitting, setSubmitting] = useState(false);

  // reactiveReason: set on submit error, informs but does NOT gate submission.
  const [reactiveReason, setReactiveReason] = useState<StatusReason | null>(null);

  // proactiveReason: derived from session state, GATES the textarea (disables it).
  const proactiveReason = readinessReason(session);

  // Belt-and-suspenders: clear the reactive reason on the not-ready→ready
  // proactive transition. Covers the case where the session went briefly
  // not-ready after a 409 and has now recovered.
  const prevProactiveRef = useRef<StatusReason | null>(proactiveReason);
  useEffect(() => {
    const prev = prevProactiveRef.current;
    prevProactiveRef.current = proactiveReason;
    if (prev !== null && proactiveReason === null) {
      setReactiveReason(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proactiveReason]);

  // What the status line shows: proactive wins (it also disables), reactive is
  // informational-only. Neither is shown when both are null.
  const visibleReason: StatusReason | null = proactiveReason ?? reactiveReason;

  // Only the proactive gate + in-flight state disable the bar.
  const isDisabled = proactiveReason !== null || submitting;
  const canSubmit = !isDisabled && draft.trim().length > 0;

  // Auto-grow the textarea up to MAX_ROWS.
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

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      // Any edit acknowledges a stale reactive reason — clear it on first keystroke
      // so "Submit failed" doesn't hang over fresh text the user is already fixing.
      if (reactiveReason !== null) setReactiveReason(null);
      setDraft(e.target.value);
    },
    [reactiveReason],
  );

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
        // 409 = session not ready yet — keep draft, surface reason. Bar stays
        // enabled so the user can retry immediately without any further action.
        setReactiveReason({
          short: err.reason ?? "Session not ready",
          detail: err.reason ?? "The session is still initialising. Please try again shortly.",
        });
      } else {
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
      // Guard against CJK/IME composition: isComposing is true while the user is
      // still mid-composition (e.g. selecting a kanji candidate).
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void handleSubmit();
      }
      // Shift+Enter falls through to the textarea's default: it inserts a newline.
    },
    [handleSubmit],
  );

  // Aria/data attributes reflect the proactive gate only.
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
            aria-describedby={visibleReason ? statusId : undefined}
            aria-disabled={ariaDisabled}
            aria-label="Send input to agent"
            placeholder={
              visibleReason
                ? visibleReason.short
                : "Send input to agent… (Enter to submit, Shift+Enter for newline)"
            }
            value={draft}
            rows={1}
            disabled={isDisabled}
            onChange={handleChange}
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
              <span className="prompt-bar-spinner" aria-hidden="true" />
            ) : (
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

        {visibleReason && (
          <p
            id={statusId}
            className="prompt-bar-status"
            role="status"
            aria-live="polite"
            data-testid="prompt-bar-status"
          >
            {visibleReason.detail}
          </p>
        )}
      </div>
    </div>
  );
};
