import type { ClaudeCodeTrustStatus, HarnessKind } from "@shared/types";

/** Only Claude Code reads the trust record, and asking is pointless unless Studio could write
 *  it for a root not trusted yet (SAP-4381). */
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
