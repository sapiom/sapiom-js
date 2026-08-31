import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { inspectManifestName, resolveManifestName } from "./definition-name.js";

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
    await expect(resolveManifestName("/proj/agent", extract)).resolves.toBe(
      "order-triage",
    );
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
    await expect(
      resolveManifestName("/proj/agent", extract),
    ).resolves.toBeNull();
  });

  it("returns null when extraction throws", async () => {
    const extract = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      resolveManifestName("/proj/agent", extract),
    ).resolves.toBeNull();
  });

  it("returns null for a blank manifest name", async () => {
    const extract = vi.fn().mockResolvedValue(extraction("   "));
    await expect(
      resolveManifestName("/proj/agent", extract),
    ).resolves.toBeNull();
  });
});

describe("inspectManifestName", () => {
  it("distinguishes an unnamed agent from a failed extraction", async () => {
    const unnamed = vi.fn().mockResolvedValue(extraction("   "));
    const failed = vi.fn().mockResolvedValue({
      result: { ok: false as const, reason: "run npm install first" },
      cached: false,
      fingerprint: "0:0",
    });

    await expect(
      inspectManifestName("/proj/unnamed", unnamed),
    ).resolves.toEqual({ status: "absent" });
    await expect(inspectManifestName("/proj/broken", failed)).resolves.toEqual({
      status: "failed",
      retryable: false,
    });
  });

  it("treats agent-core NO_DEFINITION as normal identity absence", async () => {
    const extract = vi.fn().mockResolvedValue({
      result: {
        ok: false as const,
        code: "NO_DEFINITION",
        reason: "No defineAgent() call was found",
      },
      cached: false,
      fingerprint: "1:1",
    });

    await expect(
      inspectManifestName("/proj/unnamed", extract),
    ).resolves.toEqual({ status: "absent" });
  });

  it("reports a thrown extraction as failed", async () => {
    const extract = vi.fn().mockRejectedValue(new Error("boom"));

    // The extractor told us nothing about why, so keep the retry affordance.
    await expect(inspectManifestName("/proj/broken", extract)).resolves.toEqual(
      { status: "failed", retryable: true },
    );
  });

  describe("classifying a failure as still clearable", () => {
    const roots: string[] = [];
    const failed = () =>
      vi.fn().mockResolvedValue({
        result: { ok: false as const, reason: "run npm install first" },
        cached: false,
        fingerprint: "0:0",
      });

    async function project(files: Record<string, string>): Promise<string> {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "definition-name-"));
      roots.push(root);
      for (const [relative, contents] of Object.entries(files)) {
        const file = path.join(root, relative);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, contents);
      }
      return root;
    }

    afterEach(async () => {
      await Promise.all(
        roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
      );
    });

    it("is retryable while the project still has TypeScript to name", async () => {
      const root = await project({ "index.ts": "export {};\n" });
      await expect(inspectManifestName(root, failed())).resolves.toEqual({
        status: "failed",
        retryable: true,
      });
    });

    it("stays retryable with dependencies installed", async () => {
      // Installed deps prove nothing: workspaces hoist `node_modules` to the
      // repo root, and a check process that crashed or timed out under load
      // succeeds on the next run. Only "no TypeScript at all" is provable.
      const root = await project({
        "index.ts": "export {};\n",
        "node_modules/.keep": "",
      });
      await expect(inspectManifestName(root, failed())).resolves.toEqual({
        status: "failed",
        retryable: true,
      });
    });

    it("is settled when the project has no TypeScript to name", async () => {
      // A dashboard companion: no install and no re-run can produce a
      // `defineAgent` that was never written, so this failure is the one we
      // can prove has nowhere left to go.
      const root = await project({ "server.js": "module.exports = {};\n" });
      await expect(inspectManifestName(root, failed())).resolves.toEqual({
        status: "failed",
        retryable: false,
      });
    });
  });
});
