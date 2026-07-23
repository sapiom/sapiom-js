/**
 * tool-dispatcher — the named-workflow dispatcher of the intelligence spine
 * (SAP-1807), generalizing the S1 spike (SAP-1804).
 *
 * The Studio Assistant's tools ARE Sapiom workflows we author/deploy/run on our
 * account (§2 of the app-experience design). Where the spike ran ONE hardcoded
 * workflow id, this dispatcher maps a NAMED tool (`explain-agent`, `debug-step`,
 * …) to its deployed workflow and runs it via the {@link SpineClient} — still
 * on our account, still metered by us, never the user's Claude Code tokens.
 *
 * It shapes the run's lifecycle into the typed `assistant.*` bus contract:
 *   - one `assistant.tool_call` when a known tool is invoked,
 *   - one `assistant.turn` (started → deltas → completed) narrating the run,
 *   - one `assistant.tool_result` with the terminal outcome,
 *   - an `assistant.error` on any failure.
 * All message SHAPING lives in ./assistant-messages.ts (pure, unit-tested);
 * this file owns only the ordering and the I/O (running the workflow, publishing
 * to the bus).
 *
 * Graceful degradation is the load-bearing invariant: `dispatch` NEVER throws
 * and never rejects. An unknown tool, a signed-out harness, an upstream failure,
 * or even an unexpected bug all resolve to an error turn on the bus and a typed
 * `{ ok: false }` result — the spine can degrade, but it can never crash or lock
 * the Studio.
 */

import { randomUUID } from "node:crypto";

import type { EventBus } from "./event-bus.js";
import type { SpineClient } from "./spine-client.js";
import type { RunView, StepView } from "../shared/types.js";
import {
  describeStep,
  errorMessage,
  toolCall,
  toolResult,
  turnCompleted,
  turnDelta,
  turnStarted,
} from "./assistant-messages.js";

/** A named Assistant tool bound to the Sapiom workflow that backs it. */
export interface ToolDefinition {
  /** The name the assistant / UI dispatches by (e.g. "explain-agent"). */
  name: string;
  /** The deployed workflow definition id it runs on our account. */
  definitionId: string;
}

/** Tool lookup by name. Built with {@link createToolRegistry}. */
export type ToolRegistry = ReadonlyMap<string, ToolDefinition>;

/**
 * Build a name→definition registry, rejecting duplicate names so a
 * misconfigured tool set fails loudly at wiring time rather than silently
 * shadowing one tool with another.
 */
export function createToolRegistry(
  definitions: readonly ToolDefinition[],
): ToolRegistry {
  const registry = new Map<string, ToolDefinition>();
  for (const definition of definitions) {
    if (registry.has(definition.name)) {
      throw new Error(`duplicate tool name in registry: "${definition.name}"`);
    }
    registry.set(definition.name, definition);
  }
  return registry;
}

/** Terminal outcome of a dispatch. Mirrors the `assistant.tool_result` shape. */
export type DispatchResult =
  | { ok: true; dispatchId: string; executionId: string; status: RunView["status"] }
  | { ok: false; dispatchId: string; error: string };

export interface ToolDispatcherOpts {
  /** The tools this dispatcher can run, keyed by name. */
  registry: ToolRegistry;
  /** The bus every `assistant.*` message is published onto (forwarded to /ws/events). */
  bus: Pick<EventBus, "publish">;
  /**
   * The spine client that runs a workflow on our account. Injected (built once
   * at the wiring site from the held api key) so the dispatcher owns no
   * credentials and tests can drive it with a fake client.
   */
  spineClient: SpineClient;
  /**
   * Render a step transition into the text of a streamed turn delta. Defaults to
   * {@link describeStep} (an honest progress narration). The extension point for
   * S5: a tool whose value is textual output can swap in a renderer that surfaces
   * the workflow's own output instead of step progress.
   */
  renderFrame?: (step: StepView) => string;
  /** Dispatch-correlation id generator; defaults to crypto.randomUUID. Test seam. */
  generateDispatchId?: () => string;
  /** Turn id generator; defaults to crypto.randomUUID. Test seam. */
  generateTurnId?: () => string;
}

export interface ToolDispatcher {
  /**
   * Run the named `tool` with `input` on our account, streaming the exchange
   * over the bus. Resolves with the terminal {@link DispatchResult} once
   * streaming ends. Never throws.
   */
  dispatch(tool: string, input?: Record<string, unknown>): Promise<DispatchResult>;
}

/**
 * Create a tool dispatcher. See the module header for the lifecycle and the
 * graceful-degradation invariant.
 */
export function createToolDispatcher(opts: ToolDispatcherOpts): ToolDispatcher {
  const {
    registry,
    bus,
    spineClient,
    renderFrame = describeStep,
    generateDispatchId = randomUUID,
    generateTurnId = randomUUID,
  } = opts;

  return {
    async dispatch(tool, input = {}): Promise<DispatchResult> {
      const dispatchId = generateDispatchId();

      // Unknown tool: nothing was called, so emit only an error turn (no
      // tool_call / tool_result for a call that never happened) and degrade.
      const definition = registry.get(tool);
      if (!definition) {
        const error = `unknown tool: "${tool}"`;
        bus.publish(errorMessage(dispatchId, error));
        return { ok: false, dispatchId, error };
      }

      // Everything past here is guarded: the spine client is non-throwing, but a
      // renderFrame override or a bus listener could still throw, and the spine
      // must never surface as an unhandled rejection that locks the Studio.
      try {
        bus.publish(toolCall(dispatchId, tool, input));

        const turnId = generateTurnId();
        bus.publish(turnStarted(dispatchId, turnId, "assistant"));

        const result = await spineClient.run(definition.definitionId, input, {
          onFrame: (frame) => {
            bus.publish(turnDelta(dispatchId, turnId, renderFrame(frame.step)));
          },
        });

        // Close the open turn either way so the pane never hangs on a streaming
        // caret, then report the terminal outcome.
        bus.publish(turnCompleted(dispatchId, turnId));

        if (result.ok) {
          bus.publish(
            toolResult(dispatchId, tool, {
              ok: true,
              executionId: result.executionId,
              status: result.status,
            }),
          );
          return {
            ok: true,
            dispatchId,
            executionId: result.executionId,
            status: result.status,
          };
        }

        bus.publish(errorMessage(dispatchId, result.error));
        bus.publish(toolResult(dispatchId, tool, { ok: false }));
        return { ok: false, dispatchId, error: result.error };
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : "tool dispatch failed";
        bus.publish(errorMessage(dispatchId, error));
        bus.publish(toolResult(dispatchId, tool, { ok: false }));
        return { ok: false, dispatchId, error };
      }
    },
  };
}
