import { realpath } from "node:fs/promises";
import type { AssistantAccess } from "./assistant-access.js";
import {
  contextAuthorityScope,
  nativeAuthorityScope,
} from "./assistant-authority.js";
import {
  OpenCodeAccessError,
  type OpenCodeWorkspace,
} from "./opencode-host.js";
import type { AssistantSessionStore } from "./assistant-session-store.js";

/** Resolve the current authorized binding without launching or querying OpenCode. */
export function assistantHistoryAccess(options: {
  access: Pick<AssistantAccess, "get">;
  authorize: (id: string) => Promise<OpenCodeWorkspace | null>;
  store: AssistantSessionStore;
}) {
  return async (id: string) => {
    const grant = options.access.get();
    if (!grant)
      throw new OpenCodeAccessError("Assistant access is unavailable");
    const workspace = await options.authorize(id);
    if (!workspace || workspace.harnessSessionId !== id)
      throw new OpenCodeAccessError("Workspace unavailable");
    const cwd = await realpath(workspace.cwd);
    const key = {
      harnessSessionId: id,
      cwd,
      contextAuthorityScope: contextAuthorityScope(grant, {
        harnessSessionId: id,
        cwd,
      }),
    };
    const binding = await options.store.associate(
      key,
      nativeAuthorityScope(grant, key),
      undefined,
    );
    const current = await options.authorize(id);
    const currentCwd = current ? await realpath(current.cwd) : null;
    if (
      options.access.get() !== grant ||
      !current ||
      current.harnessSessionId !== id ||
      currentCwd !== cwd
    )
      throw new OpenCodeAccessError("Assistant access changed");
    return binding;
  };
}
