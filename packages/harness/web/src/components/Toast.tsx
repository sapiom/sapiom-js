import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import type { ToastTone } from "../lib/toast";
import { Icon } from "./Icon";

interface ToastProps {
  message: string;
  tone?: ToastTone;
  onDismiss: () => void;
}

/** Auto-dismiss delay — long enough to read a sentence, short enough not to
 *  linger and get mistaken for a persistent state indicator. */
const AUTO_DISMISS_MS = 8_000;

/** Ceiling for the exit animation — the real unmount is driven by
 *  `animationend`, this only guarantees dismissal if that event never fires
 *  (e.g. the tab was backgrounded mid-animation). */
const EXIT_FALLBACK_MS = 400;

const TONE_ICON: Record<ToastTone, string> = {
  info: "Info",
  error: "TriangleAlert",
};

/**
 * A single transient, dismissible message anchored to the bottom of the
 * viewport. There's exactly one slot (see `useHarnessState`'s `toast`) —
 * this app doesn't queue/stack multiple errors, it just always shows the
 * most recent one.
 *
 * The tone is carried by the leading ICON, not by a coloured bar or wash on
 * the container — a bar paints meaning onto the frame instead of into the
 * content, and because every toast used to get the red one, a finished scan
 * reporting how many projects it found announced itself as a failure. The
 * icon is the same one the rest of the app already uses for the same idea.
 *
 * Lifecycle: rises in on the shared spring ease, auto-dismisses after
 * AUTO_DISMISS_MS (paused while hovered or focused, so it can't vanish
 * mid-read), and plays a short exit animation before unmounting. The root
 * is keyed on `message` so a replacement message replays the entrance
 * instead of silently swapping text.
 */
export function Toast({ message, tone = "error", onDismiss }: ToastProps): JSX.Element {
  const [leaving, setLeaving] = useState(false);
  const [held, setHeld] = useState(false);

  const beginDismiss = useCallback(() => setLeaving(true), []);

  useEffect(() => {
    setLeaving(false);
  }, [message]);

  useEffect(() => {
    if (leaving || held) return;
    const timer = window.setTimeout(beginDismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [message, leaving, held, beginDismiss]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(onDismiss, EXIT_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, onDismiss]);

  return (
    <div
      key={message}
      className={leaving ? "toast is-leaving" : "toast"}
      role="alert"
      data-tone={tone}
      data-testid="toast"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      onAnimationEnd={leaving ? onDismiss : undefined}
    >
      <span className="toast-icon" aria-hidden="true">
        <Icon name={TONE_ICON[tone]} size={16} />
      </span>
      <span className="toast-message">{message}</span>
      <button className="toast-dismiss" aria-label="Dismiss" onClick={beginDismiss}>
        <Icon name="X" size={14} />
      </button>
    </div>
  );
}
