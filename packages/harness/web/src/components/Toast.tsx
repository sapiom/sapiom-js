import { useEffect } from "react";
import type { JSX } from "react";

interface ToastProps {
  message: string;
  onDismiss: () => void;
}

/** Auto-dismiss delay — long enough to read a sentence, short enough not to
 *  linger and get mistaken for a persistent state indicator. */
const AUTO_DISMISS_MS = 8_000;

/**
 * A single transient, dismissible message anchored to the bottom of the
 * viewport. There's exactly one slot (see `useHarnessState`'s `toast`) —
 * this app doesn't queue/stack multiple errors, it just always shows the
 * most recent one, which is enough for what currently produces one (a
 * failed macro run).
 */
export function Toast({ message, onDismiss }: ToastProps): JSX.Element {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);

  return (
    <div className="toast" role="alert" data-testid="toast">
      <span className="toast-message">{message}</span>
      <button className="toast-dismiss" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
