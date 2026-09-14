import type { AssistantStateSnapshot } from "../shared/assistant-state.js";
import type { AssistantLifecycleCoordinator } from "./assistant-lifecycle.js";
import type { OpenCodeHost } from "./opencode-host.js";

/** One ordering clock for runtime observations and durable lifecycle changes. */
export function createAssistantStateProjection(
  host: Pick<OpenCodeHost, "getAssistantState" | "subscribeAssistantState">,
  lifecycle: Pick<AssistantLifecycleCoordinator, "snapshot" | "subscribe">,
  publish: (snapshot: AssistantStateSnapshot) => void,
  isVisible: (id: string) => boolean = () => true,
) {
  let revision = 0;
  const get = (): AssistantStateSnapshot => {
    // Reading access may synchronously revoke it and notify host subscribers.
    const runtime = host.getAssistantState();
    return {
      ...runtime,
      revision,
      sessions: runtime.sessions.filter((state) =>
        isVisible(state.harnessSessionId),
      ),
      lifecycles: runtime.enabled
        ? lifecycle
            .snapshot()
            .filter(
              (state) =>
                isVisible(state.harnessSessionId) &&
                (state.revision > 0 || state.lifecycle === "ending"),
            )
        : [],
    };
  };
  const changed = () => {
    revision++;
    publish(get());
  };
  const stopHost = host.subscribeAssistantState(changed);
  const stopLifecycle = lifecycle.subscribe(changed);
  return {
    get,
    invalidate: changed,
    dispose: () => {
      stopHost();
      stopLifecycle();
    },
  };
}
