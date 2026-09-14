import { clearTimeout, setTimeout } from "node:timers";
import type { AssistantLifecycle } from "../shared/assistant-session.js";
import type { AssistantLifecycleCoordinator } from "./assistant-lifecycle.js";
import type { AssistantSessionStore } from "./assistant-session-store.js";
import type { SessionManager } from "./session-manager.js";

export type AssistantEndResult =
  | { ok: true; lifecycle: AssistantLifecycle }
  | { ok: false; code: "cleanup_unconfirmed"; error: string };

interface Options {
  store: Pick<AssistantSessionStore, "lifecycle">;
  lifecycle: Pick<
    AssistantLifecycleCoordinator,
    "beginEnd" | "finishEnd" | "snapshot"
  >;
  sessionManager: Pick<SessionManager, "closeWithResult">;
  timeoutMs?: number;
}
interface Evidence {
  prior: Promise<AssistantLifecycle | null>;
  native: boolean;
  terminal: boolean;
}
const unconfirmed = (): AssistantEndResult => ({
  ok: false,
  code: "cleanup_unconfirmed",
  error:
    "Session cleanup could not be confirmed. The session and its history have been retained.",
});
const call = <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return operation();
  } catch (error) {
    return Promise.reject(error);
  }
};
async function bounded<T>(
  operation: Promise<T>,
  deadline: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(
          () => resolve(undefined),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One owner per host for complete End operations. Completed retries check both
 * engines again: Terminal can resume without changing the Assistant header.
 * Local End requires boot authorization, never a current Assistant grant. */
export class AssistantEndCoordinator {
  private readonly pending = new Map<string, Promise<AssistantEndResult>>();
  private readonly evidence = new Map<string, Evidence>();

  constructor(private readonly options: Options) {}

  end(id: string): Promise<AssistantEndResult> {
    const pending = this.pending.get(id);
    if (pending) return pending;
    const current = this.options.lifecycle
      .snapshot()
      .find((state) => state.harnessSessionId === id);
    if (current?.lifecycle === "open") this.evidence.delete(id);

    // Install the single-flight slot before any synchronous retirement callback.
    let resolve!: (result: AssistantEndResult) => void;
    const promise = new Promise<AssistantEndResult>((done) => {
      resolve = done;
    });
    this.pending.set(id, promise);
    const finish = (result: AssistantEndResult) => {
      if (result.ok) this.evidence.delete(id);
      if (this.pending.get(id) === promise) this.pending.delete(id);
      resolve(result);
    };
    void this.run(id).then(finish, () => finish(unconfirmed()));
    return promise;
  }

  private async run(id: string): Promise<AssistantEndResult> {
    const deadline = Date.now() + (this.options.timeoutMs ?? 5_000);
    let evidence = this.evidence.get(id);
    if (!evidence) {
      // Capture the original durable state before beginEnd can write "ending".
      evidence = {
        prior: bounded(
          call(() => this.options.store.lifecycle(id)),
          deadline,
        ).then((prior) => {
          if (prior === undefined) throw new Error("End snapshot timed out");
          return prior;
        }),
        native: false,
        terminal: false,
      };
      this.evidence.set(id, evidence);
      const owned = evidence;
      void evidence.prior.catch(() => {
        if (this.evidence.get(id) === owned) this.evidence.delete(id);
      });
    }
    const owned = evidence;
    let beginning: ReturnType<Options["lifecycle"]["beginEnd"]> | undefined;
    try {
      beginning = this.options.lifecycle.beginEnd(id, evidence.prior);
    } catch {
      // Even a native retirement failure must not prevent Terminal cancellation.
    }
    const terminal = call(() =>
      this.options.sessionManager.closeWithResult(id),
    ).then((result) => {
      if (result.state === "confirmed") owned.terminal = true;
      return result;
    });
    // Both shutdown requests above run synchronously before this method awaits.
    if (!beginning) {
      await bounded(Promise.allSettled([evidence.prior, terminal]), deadline);
      return unconfirmed();
    }
    const native = beginning.native.then((result) => {
      if (result.state === "confirmed") owned.native = true;
      return result;
    });
    const results = await bounded(
      Promise.allSettled([
        evidence.prior,
        beginning.persistence,
        native,
        terminal,
      ] as const),
      deadline,
    );
    if (!results) return unconfirmed();
    const [prior, persistence, nativeResult, terminalResult] = results;
    if (
      prior.status !== "fulfilled" ||
      persistence.status !== "fulfilled" ||
      nativeResult.status !== "fulfilled" ||
      terminalResult.status !== "fulfilled" ||
      nativeResult.value.state === "unconfirmed" ||
      terminalResult.value.state === "unconfirmed"
    )
      return unconfirmed();
    // An old host's "ending" header carries unresolved process ownership.
    // Absence in this boot cannot replace positive evidence for either engine.
    if (
      prior.value?.lifecycle === "ending" &&
      (!owned.native || !owned.terminal)
    )
      return unconfirmed();
    if (Date.now() >= deadline) return unconfirmed();
    try {
      const lifecycle = await bounded(
        this.options.lifecycle.finishEnd(beginning.fence),
        deadline,
      );
      return lifecycle ? { ok: true, lifecycle } : unconfirmed();
    } catch {
      return unconfirmed();
    }
  }
}
