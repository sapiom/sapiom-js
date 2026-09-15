import { realpath } from "node:fs/promises";
import type { AssistantAccess, AssistantGrant } from "./assistant-access.js";
import {
  contextAuthorityScope,
  nativeAuthorityScope,
} from "./assistant-authority.js";
import {
  OpenCodeAccessError,
  type OpenCodeWorkspace,
} from "./opencode-host.js";
import type { AssistantSessionStore } from "./assistant-session-store.js";

const authority = (grant: AssistantGrant | null): string | null =>
  !grant || grant.expiresAt <= Date.now()
    ? null
    : JSON.stringify([
        grant.userId,
        grant.tenantId,
        grant.identityRevision,
        grant.environment.name,
        grant.environment.apiURL,
        grant.environment.credentials?.apiKey,
      ]);

/** Resolve the current authorized binding without launching or querying OpenCode. */
export function assistantHistoryAccess(options: {
  access: Pick<AssistantAccess, "get">;
  authorize: (id: string) => Promise<OpenCodeWorkspace | null>;
  store: AssistantSessionStore;
}) {
  const captureAuthority = () => {
    const captured = authority(options.access.get());
    if (!captured)
      throw new OpenCodeAccessError("Assistant access is unavailable");
    return () => {
      if (authority(options.access.get()) !== captured)
        throw new OpenCodeAccessError("Assistant access changed");
    };
  };
  const resolve = async (id: string) => {
    const grant = options.access.get();
    const captured = authority(grant);
    if (!grant || !captured)
      throw new OpenCodeAccessError("Assistant access is unavailable");
    const snapshot = { ...grant, environment: { ...grant.environment } };
    const workspace = await options.authorize(id);
    if (!workspace || workspace.harnessSessionId !== id)
      throw new OpenCodeAccessError("Workspace unavailable");
    const workspaceCwd = workspace.cwd;
    const cwd = await realpath(workspaceCwd);
    const key = {
      harnessSessionId: id,
      cwd,
      contextAuthorityScope: contextAuthorityScope(snapshot, {
        harnessSessionId: id,
        cwd,
      }),
    };
    const binding = await options.store.associate(
      key,
      nativeAuthorityScope(snapshot, key),
      undefined,
    );
    const current = await options.authorize(id);
    const currentCwd = current ? await realpath(current.cwd) : null;
    if (
      authority(options.access.get()) !== captured ||
      !current ||
      current.harnessSessionId !== id ||
      current.cwd !== workspaceCwd ||
      currentCwd !== cwd
    )
      throw new OpenCodeAccessError("Assistant access changed");
    return binding;
  };
  return Object.assign(resolve, { captureAuthority });
}
