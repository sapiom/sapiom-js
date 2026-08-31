import type { BusMessage } from "@shared/types";
import type {
  SystemGraphLifecycleState,
  WorkspaceKey,
} from "@shared/system-graph";

export interface SystemGraphAnnouncement {
  workspaceKey: WorkspaceKey;
  revision: number;
  state: SystemGraphLifecycleState;
}

/**
 * A lossless reducer for the generic event stream. React may batch consecutive
 * WebSocket frames, so graph invalidations cannot live in a single last-event
 * slot that an unrelated frame can overwrite.
 */
export function systemGraphAnnouncementsAfterMessage(
  current: Map<WorkspaceKey, SystemGraphAnnouncement>,
  message: BusMessage,
): Map<WorkspaceKey, SystemGraphAnnouncement> {
  if (message.type !== "system-graph.changed") return current;
  const existing = current.get(message.workspaceKey);
  if (existing && existing.revision >= message.revision) {
    return current;
  }
  const next = new Map(current);
  next.set(message.workspaceKey, {
    workspaceKey: message.workspaceKey,
    revision: message.revision,
    state: message.state,
  });
  return next;
}

export function retainSystemGraphAnnouncements(
  current: Map<WorkspaceKey, SystemGraphAnnouncement>,
  workspaceKeys: ReadonlySet<WorkspaceKey>,
): Map<WorkspaceKey, SystemGraphAnnouncement> {
  if (
    [...current.keys()].every((workspaceKey) => workspaceKeys.has(workspaceKey))
  ) {
    return current;
  }
  return new Map(
    [...current].filter(([workspaceKey]) => workspaceKeys.has(workspaceKey)),
  );
}
