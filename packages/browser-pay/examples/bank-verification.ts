import type { VerificationHandle, VerificationState } from "../src/index.js";

/** Host callbacks operate the existing task and privately notify its buyer; they never create a browser. */
export interface BankHandoff {
  /** Resolve true only after this handoff paused the task and confirmed its paused state. */
  pause(): Promise<boolean>;
  sendPrivateLink(url: string): Promise<void>;
  /** Observe the same merchant checkout, without card values or another Pay action. */
  resumeObservation(): Promise<void>;
}

/** Run alongside the original checkout after attaching Browser Pay, within its existing session deadline. */
export async function monitorBankVerification(
  verification: VerificationHandle,
  handoff: BankHandoff,
  signal: AbortSignal,
): Promise<VerificationState> {
  let pausedHere = false;
  let notified = false;
  for (;;) {
    signal.throwIfAborted();
    const state = verification.current();
    if (!["preparing", "requires_action", "checking"].includes(state.status)) {
      if (pausedHere && state.interactionReturned)
        await handoff.resumeObservation();
      return state;
    }
    if (state.challengeCaptured && !pausedHere) {
      pausedHere = await handoff.pause();
      if (!pausedHere) throw new Error("Checkout task could not be paused");
    }
    if (pausedHere && !notified && state.actionUrl) {
      await handoff.sendPrivateLink(state.actionUrl);
      notified = true;
    }
    // The SDK already synchronizes the backend. This reads local state without another API request.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
}
