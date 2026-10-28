import type { ClaudeCodeTrustStatus, HarnessKind } from "@shared/types";

/**
 * Whether to ask "Trust this folder?" before starting a session (SAP-4381).
 * Only Claude Code reads the trust record, and only an added root that is
 * not trusted yet and that Studio could actually write is worth asking about.
 */
export function shouldAskFolderTrust(
  harness: HarnessKind,
  status: ClaudeCodeTrustStatus,
): status is ClaudeCodeTrustStatus & { root: string } {
  return (
    harness === "claude-code" &&
    status.root !== null &&
    status.trustable &&
    !status.trusted
  );
}
