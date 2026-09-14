import type { AssistantStateSnapshot } from "../shared/assistant-state.js";
import type { AssistantLifecycleCoordinator } from "./assistant-lifecycle.js";
import type { OpenCodeHost } from "./opencode-host.js";

/** One ordering clock for runtime observations and durable lifecycle changes. */
export function createAssistantStateProjection(
  host: Pick<OpenCodeHost, "getAssistantState" | "subscribeAssistantState">,
  lifecycle: Pick<AssistantLifecycleCoordinator, "snapshot" | "subscribe">,
  publish: (snapshot: AssistantStateSnapshot) => void,
) {
  let revision = 0;
  const get = (): AssistantStateSnapshot => {
    // Reading access may synchronously revoke it and notify host subscribers.
    const runtime = host.getAssistantState();
    return {
      ...runtime,
      revision,
      lifecycles: runtime.enabled ? lifecycle.snapshot() : [],
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
    dispose: () => {
      stopHost();
      stopLifecycle();
    },
  };
}
