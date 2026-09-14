import { createHash } from "node:crypto";
import type { AssistantGrant } from "./assistant-access.js";

interface Workspace {
  harnessSessionId: string;
  cwd: string;
}

/** Callers authorize and canonicalize the workspace before deriving either key. */
export function contextAuthorityScope(
  grant: AssistantGrant,
  workspace: Workspace,
): string {
  const api = new URL(grant.environment.apiURL);
  if (
    !["http:", "https:"].includes(api.protocol) ||
    api.username ||
    api.password ||
    api.search ||
    api.hash
  )
    throw new Error("Assistant environment is invalid");
  api.pathname = api.pathname.replace(/\/+$/, "") || "/";
  return hash([
    grant.userId,
    grant.tenantId,
    grant.environment.name,
    api.href,
    workspace.cwd,
    workspace.harnessSessionId,
  ]);
}

/** Preserve the pre-migration native directory mapping exactly. */
export function nativeAuthorityScope(
  grant: AssistantGrant,
  workspace: Workspace,
): string {
  return hash([
    grant.userId,
    grant.tenantId,
    workspace.harnessSessionId,
    workspace.cwd,
  ]);
}

const hash = (parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
