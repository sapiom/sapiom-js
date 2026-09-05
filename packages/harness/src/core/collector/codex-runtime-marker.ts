import { canonicalDigest } from "../../shared/agent-map-canonical.js";

/** Non-secret correlation proof injected by the host into a fresh child kickoff. */
export const codexRuntimeMarker = (runtimeEpoch: string): string =>
  `<sapiom-codex-runtime ref="${canonicalDigest("sapiom.codex.runtime.v1", runtimeEpoch)}" />`;

export const parseCodexRuntimeMarker = (prompt: string): string | null => {
  const firstLine = prompt.split("\n", 1)[0]?.trimEnd() ?? "";
  return /^<sapiom-codex-runtime ref="sha256:[0-9a-f]{64}" \/>$/u.test(firstLine) ? firstLine : null;
};
