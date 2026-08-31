import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentInventoryItem } from "./system-graph-inventory.js";
import {
  CachedAgentRelationshipProvider,
  SourceAgentRelationshipProvider,
  type AgentRelationshipProvider,
} from "./system-graph-relationships.js";

const temporaryRoots: string[] = [];

async function callerWithSource(source: string): Promise<AgentInventoryItem> {
  const sourceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "system-graph-relationships-test-"),
  );
  temporaryRoots.push(sourceRoot);
  await fs.writeFile(path.join(sourceRoot, "index.ts"), source);
  return {
    agentKey: "research",
    identityStatus: "canonical",
    definitionId: 1,
    definitionSlug: "research",
    label: "Research",
    resolutionAliases: ["research"],
    sourceRoot,
    workflowPath: sourceRoot,
    path: ".",
    entrypoint: "index.ts",
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("SourceAgentRelationshipProvider", () => {
  it("aggregates evidence by target and mode while preserving distinct modes", async () => {
    const caller = await callerWithSource(`
ctx.sapiom.agents.run({ definition: "growth" });
ctx.sapiom.agents.run({ definition: "growth" });
ctx.sapiom.agents.launch({ definition: "growth" });
ctx.sapiom.agents.launch({ definition: dynamicTarget });
`);

    const result =
      await new SourceAgentRelationshipProvider().listRelationships(caller);

    expect(result.relationships).toEqual([
      {
        target: "growth",
        mode: "blocking",
        evidence: [
          { file: "index.ts", line: 2, column: 1 },
          { file: "index.ts", line: 3, column: 1 },
        ],
      },
      {
        target: "growth",
        mode: "async",
        evidence: [{ file: "index.ts", line: 4, column: 1 }],
      },
    ]);
    expect(result.warnings).toEqual([
      {
        code: "dynamic-target",
        mode: "async",
        evidence: { file: "index.ts", line: 5, column: 1 },
      },
    ]);
  });

  it("returns identical relationship semantics for unchanged caller input", async () => {
    const caller = await callerWithSource(
      'ctx.sapiom.agents.run({ definition: "growth" });\n',
    );
    const provider = new SourceAgentRelationshipProvider();

    const first = await provider.listRelationships(caller);
    const second = await provider.listRelationships(caller);

    expect(second).toEqual(first);
  });
});

describe("CachedAgentRelationshipProvider", () => {
  it("coalesces and reuses unchanged caller extraction", async () => {
    const caller = await callerWithSource("export const value = 1;\n");
    const inner: AgentRelationshipProvider = {
      listRelationships: vi.fn(async () => ({
        relationships: [],
        warnings: [],
      })),
    };
    const fingerprint = vi.fn(async () => "fingerprint-one");
    const provider = new CachedAgentRelationshipProvider(inner, fingerprint);

    const first = provider.listRelationships(caller);
    await expect(provider.listRelationships(caller)).resolves.toEqual(
      await first,
    );
    await provider.listRelationships(caller);

    expect(inner.listRelationships).toHaveBeenCalledTimes(1);
    expect(fingerprint).toHaveBeenCalledTimes(3);
  });

  it("rescans only after the caller fingerprint changes", async () => {
    const caller = await callerWithSource("export const value = 1;\n");
    const inner: AgentRelationshipProvider = {
      listRelationships: vi.fn(async () => ({
        relationships: [],
        warnings: [],
      })),
    };
    const fingerprint = vi
      .fn()
      .mockResolvedValueOnce("one")
      .mockResolvedValueOnce("two");
    const provider = new CachedAgentRelationshipProvider(inner, fingerprint);

    await provider.listRelationships(caller);
    await provider.listRelationships(caller);

    expect(inner.listRelationships).toHaveBeenCalledTimes(2);
  });

  it("does not retain a failed caller result", async () => {
    const caller = await callerWithSource("export const value = 1;\n");
    const inner: AgentRelationshipProvider = {
      listRelationships: vi
        .fn()
        .mockRejectedValueOnce(new Error("not installed"))
        .mockResolvedValueOnce({ relationships: [], warnings: [] }),
    };
    const provider = new CachedAgentRelationshipProvider(
      inner,
      async () => "same",
    );

    await expect(provider.listRelationships(caller)).rejects.toThrow(
      "not installed",
    );
    await expect(provider.listRelationships(caller)).resolves.toEqual({
      relationships: [],
      warnings: [],
    });
    expect(inner.listRelationships).toHaveBeenCalledTimes(2);
  });

  it("evicts removed callers while preserving retained callers", async () => {
    const first = await callerWithSource("export const first = 1;\n");
    const second = await callerWithSource("export const second = 1;\n");
    const inner: AgentRelationshipProvider = {
      listRelationships: vi.fn(async () => ({
        relationships: [],
        warnings: [],
      })),
    };
    const provider = new CachedAgentRelationshipProvider(
      inner,
      async () => "same",
    );
    await provider.listRelationships(first);
    await provider.listRelationships(second);

    provider.retainCallers([second]);
    await provider.listRelationships(first);
    await provider.listRelationships(second);

    expect(inner.listRelationships).toHaveBeenCalledTimes(3);
  });
});
