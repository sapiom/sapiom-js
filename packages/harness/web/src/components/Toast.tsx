import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Icon } from "./Icon";

interface ToastProps {
  message: string;
  onDismiss: () => void;
}

/** Auto-dismiss delay — long enough to read a sentence, short enough not to
 *  linger and get mistaken for a persistent state indicator. */
const AUTO_DISMISS_MS = 8_000;

/** Ceiling for the exit animation — the real unmount is driven by
 *  `animationend`, this only guarantees dismissal if that event never fires
 *  (e.g. the tab was backgrounded mid-animation). */
const EXIT_FALLBACK_MS = 400;

/**
 * A single transient, dismissible message anchored to the bottom of the
 * viewport. There's exactly one slot (see `useHarnessState`'s `toast`) —
 * this app doesn't queue/stack multiple errors, it just always shows the
 * most recent one, which is enough for what currently produces one (a
 * failed macro run).
 *
 * Lifecycle: rises in on the shared spring ease, auto-dismisses after
 * AUTO_DISMISS_MS (paused while hovered or focused, so it can't vanish
 * mid-read), and plays a short exit animation before unmounting. The root
 * is keyed on `message` so a replacement message replays the entrance
 * instead of silently swapping text.
 */
export function Toast({ message, onDismiss }: ToastProps): JSX.Element {
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
      data-testid="toast"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      onAnimationEnd={leaving ? onDismiss : undefined}
    >
      <span className="toast-message">{message}</span>
      <button className="toast-dismiss" aria-label="Dismiss" onClick={beginDismiss}>
        <Icon name="X" size={14} />
      </button>
    </div>
  );
}
