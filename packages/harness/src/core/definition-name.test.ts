import { describe, expect, it, vi } from "vitest";

import { resolveManifestName } from "./definition-name.js";

/** A cached-extraction result shaped like canvas-cache's, with just the field
 *  under test populated. */
function extraction(manifestName: string) {
  return {
    result: {
      ok: true as const,
      graph: {
        manifestName,
        entry: "start",
        nodes: [],
        edges: [],
        warnings: [],
      },
    },
    cached: true,
    fingerprint: "1:1",
  };
}

describe("resolveManifestName", () => {
  it("returns the agent's declared manifest name", async () => {
    const extract = vi.fn().mockResolvedValue(extraction("order-triage"));
    await expect(resolveManifestName("/proj/agent", extract)).resolves.toBe("order-triage");
    expect(extract).toHaveBeenCalledWith("/proj/agent");
  });

  it("returns null when extraction failed", async () => {
    // The usual cause: node_modules isn't installed yet, so the check process
    // cannot bundle. The caller falls back to another name source.
    const extract = vi.fn().mockResolvedValue({
      result: { ok: false as const, reason: "run npm install first" },
      cached: false,
      fingerprint: "0:0",
    });
    await expect(resolveManifestName("/proj/agent", extract)).resolves.toBeNull();
  });

  it("returns null when extraction throws", async () => {
    const extract = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(resolveManifestName("/proj/agent", extract)).resolves.toBeNull();
  });

  it("returns null for a blank manifest name", async () => {
    const extract = vi.fn().mockResolvedValue(extraction("   "));
    await expect(resolveManifestName("/proj/agent", extract)).resolves.toBeNull();
  });
});
