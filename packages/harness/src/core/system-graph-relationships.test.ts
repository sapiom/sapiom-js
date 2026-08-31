import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentInventoryItem } from "./system-graph-inventory.js";
import {
  CachedAgentInvocationProvider,
  SourceAgentInvocationProvider,
  createSystemGraphPackageCompilerResult,
  type AgentInvocationProvider,
  type AgentInvocationProviderResult,
} from "./system-graph-relationships.js";
import {
  clearCanonicalGraphPathCacheForTest,
  setCanonicalGraphPathProbeForTest,
} from "./canonical-graph-path.js";

const temporaryRoots: string[] = [];
const EMPTY_RESULT: AgentInvocationProviderResult = {
  invocations: [],
  warnings: [],
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function callerWithSource(source: string): Promise<AgentInventoryItem> {
  const sourceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "system-graph-invocations-test-"),
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

async function packageWithCallers(
  files: Record<string, string>,
  agents: readonly string[],
): Promise<AgentInventoryItem[]> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "system-graph-package-invocations-test-"),
  );
  temporaryRoots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  return agents.map((agentKey, index) => {
    const sourceRoot = path.join(root, "agents", agentKey);
    return {
      agentKey,
      identityStatus: "canonical",
      definitionId: index + 1,
      definitionSlug: agentKey,
      label: agentKey,
      resolutionAliases: [agentKey],
      sourceRoot,
      workflowPath: sourceRoot,
      path: `agents/${agentKey}`,
      entrypoint: "index.ts",
    };
  });
}

afterEach(async () => {
  clearCanonicalGraphPathCacheForTest();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("SourceAgentInvocationProvider", () => {
  it("aggregates evidence by target and mode while preserving distinct modes", async () => {
    const caller = await callerWithSource(`
ctx.sapiom.agents.run({ definition: "growth" });
ctx.sapiom.agents.run({ definition: "growth" });
ctx.sapiom.agents.launch({ definition: "growth" });
ctx.sapiom.agents.launch({ definition: dynamicTarget });
`);

    const result = await new SourceAgentInvocationProvider().listInvocations(
      caller,
    );

    expect(result.invocations).toEqual([
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
    expect(result.complete).toBe(true);
    expect(result.sourceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("reports only the coordinator's direct invocations without inferring output data flow", async () => {
    const caller = {
      ...(await callerWithSource(`
import { agents } from "@sapiom/tools";

const research = await agents.run({
  definition: "research",
});

const summary = formatResearch(research.output);

await agents.run({
  definition: "growth",
  input: { summary },
});
`)),
      agentKey: "coordinator",
      definitionSlug: "coordinator",
      label: "Coordinator",
      resolutionAliases: ["coordinator"],
    };

    const result = await new SourceAgentInvocationProvider().listInvocations(
      caller,
    );
    const directInvocations = result.invocations.map(({ target }) => [
      caller.agentKey,
      target,
    ]);

    expect(directInvocations).toEqual([
      ["coordinator", "research"],
      ["coordinator", "growth"],
    ]);
    expect(directInvocations).not.toContainEqual(["research", "growth"]);
  });

  it("returns identical invocation semantics for unchanged caller input", async () => {
    const caller = await callerWithSource(
      'ctx.sapiom.agents.run({ definition: "growth" });\n',
    );
    const provider = new SourceAgentInvocationProvider();

    const first = await provider.listInvocations(caller);
    const second = await provider.listInvocations(caller);

    expect(second).toEqual(first);
  });

  it("uses source content, not mtimes or watcher paths, as analysis freshness", async () => {
    const sourceText = 'ctx.sapiom.agents.run({ definition: "growth" });\n';
    const caller = await callerWithSource(sourceText);
    const provider = new SourceAgentInvocationProvider();
    const entrypoint = path.join(caller.sourceRoot, "index.ts");

    const first = await provider.listInvocations(caller);
    await fs.utimes(entrypoint, new Date(1_000), new Date(2_000));
    const touched = await provider.listInvocations(caller);
    await fs.writeFile(entrypoint, `${sourceText}// source-only edit\n`);
    const edited = await provider.listInvocations(caller);

    expect(touched.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(edited.invocations).toEqual(first.invocations);
    expect(edited.sourceFingerprint).not.toBe(first.sourceFingerprint);
    expect(edited.sourceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("does not follow a TypeScript symlink outside the workflow", async () => {
    const caller = await callerWithSource("export const value = 1;\n");
    const external = await fs.mkdtemp(
      path.join(os.tmpdir(), "system-graph-invocations-external-"),
    );
    temporaryRoots.push(external);
    await fs.writeFile(
      path.join(external, "secret.ts"),
      'ctx.sapiom.agents.run({ definition: "outside" });\n',
    );
    await fs.symlink(
      path.join(external, "secret.ts"),
      path.join(caller.sourceRoot, "evil.ts"),
    );
    const onBytesRead = vi.fn();

    const result = await new SourceAgentInvocationProvider({
      onBytesRead,
    }).listInvocations(caller);

    expect(result.invocations).toEqual([]);
    expect(result.complete).toBe(false);
    expect(onBytesRead).toHaveBeenCalledTimes(1);
    expect(onBytesRead).toHaveBeenCalledWith(
      path.join(caller.sourceRoot, "index.ts"),
      expect.any(Number),
    );
    expect(onBytesRead).not.toHaveBeenCalledWith(
      path.join(external, "secret.ts"),
      expect.any(Number),
    );
  });

  it("rejects an ancestor swap before reading invocation source bytes", async () => {
    const caller = await callerWithSource("export const value = 1;\n");
    const inside = path.join(caller.sourceRoot, "inside");
    await fs.mkdir(inside);
    await fs.writeFile(
      path.join(inside, "edge.ts"),
      'ctx.sapiom.agents.run({ definition: "inside" });\n',
    );
    const external = await fs.mkdtemp(
      path.join(os.tmpdir(), "system-graph-invocations-swap-"),
    );
    temporaryRoots.push(external);
    await fs.writeFile(
      path.join(external, "edge.ts"),
      'ctx.sapiom.agents.run({ definition: "outside" });\n',
    );
    const onBytesRead = vi.fn();
    let swapped = false;

    const result = await new SourceAgentInvocationProvider({
      beforeOpen: async (file) => {
        if (!file.endsWith(`${path.sep}inside${path.sep}edge.ts`) || swapped) {
          return;
        }
        swapped = true;
        await fs.rename(inside, `${inside}-original`);
        await fs.symlink(external, inside, "dir");
      },
      onBytesRead,
    }).listInvocations(caller);

    expect(result.invocations).toEqual([]);
    expect(result.complete).toBe(false);
    expect(onBytesRead).not.toHaveBeenCalledWith(
      path.join(external, "edge.ts"),
      expect.any(Number),
    );
  });

  it("resolves re-exported namespaces and shared wrapper functions with one package program", async () => {
    const [coordinator, research] = await packageWithCallers(
      {
        "node_modules/@sapiom/tools/index.d.ts": `
export declare const agents: {
  run(spec: { definition: string }): Promise<unknown>;
  launch(spec: { definition: string }): Promise<unknown>;
};
`,
        "shared/sapiom.ts": `
export { agents as routedAgents } from "@sapiom/tools";
`,
        "shared/router.ts": `
import { routedAgents } from "./sapiom";

export function launchGrowth() {
  return routedAgents.launch({ definition: "growth" });
}

export function runNamed(definition: string) {
  return routedAgents.run({ definition });
}
`,
        "agents/coordinator/index.ts": `
import { launchGrowth, runNamed } from "../../shared/router";

await launchGrowth();
await runNamed("research");
`,
        "agents/research/index.ts": "export const idle = true;\n",
      },
      ["coordinator", "research"],
    );
    const provider = new SourceAgentInvocationProvider();
    provider.retainCallers([coordinator!, research!]);

    const coordinatorResult = await provider.listInvocations(coordinator!);
    const researchResult = await provider.listInvocations(research!);

    expect(coordinatorResult.invocations).toEqual([
      {
        target: "growth",
        mode: "async",
        evidence: [{ file: "index.ts", line: 4, column: 7 }],
      },
      {
        target: "research",
        mode: "blocking",
        evidence: [{ file: "index.ts", line: 5, column: 7 }],
      },
    ]);
    expect(coordinatorResult.warnings).toEqual([]);
    expect(researchResult.invocations).toEqual([]);
    expect(researchResult.warnings).toEqual([]);
    expect(coordinatorResult.sourceFingerprint).toBe(
      researchResult.sourceFingerprint,
    );
  });

  it("keeps same-key retained callers independent across packages", async () => {
    const [[first], [second]] = await Promise.all([
      packageWithCallers(
        {
          "agents/router/index.ts":
            'ctx.sapiom.agents.run({ definition: "first-target" });\n',
        },
        ["router"],
      ),
      packageWithCallers(
        {
          "agents/router/index.ts":
            'ctx.sapiom.agents.run({ definition: "second-target" });\n',
        },
        ["router"],
      ),
    ]);
    const provider = new SourceAgentInvocationProvider();
    provider.retainCallers([first!, second!]);

    await expect(provider.listInvocations(first!)).resolves.toMatchObject({
      invocations: [{ target: "first-target", mode: "blocking" }],
    });
    await expect(provider.listInvocations(second!)).resolves.toMatchObject({
      invocations: [{ target: "second-target", mode: "blocking" }],
    });
  });

  it("keeps external imports outside the bounded compiler snapshot", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "system-graph-package-boundary-test-"),
    );
    const external = await fs.mkdtemp(
      path.join(os.tmpdir(), "system-graph-external-import-test-"),
    );
    temporaryRoots.push(root, external);
    await fs.mkdir(path.join(root, "agents", "coordinator"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(external, "secret.ts"),
      'ctx.sapiom.agents.run({ definition: "outside" });\n',
    );
    const specifier = path
      .relative(path.join(root, "agents", "coordinator"), path.join(external, "secret"))
      .split(path.sep)
      .join(path.posix.sep);
    await fs.writeFile(
      path.join(root, "agents", "coordinator", "index.ts"),
      `import "${specifier}";\n`,
    );
    const onBytesRead = vi.fn();

    const result = await createSystemGraphPackageCompilerResult({
      packageRoot: root,
      readHooks: { onBytesRead },
    });

    expect([...result.sources.keys()]).not.toContain(
      path.join(external, "secret.ts"),
    );
    expect(onBytesRead).not.toHaveBeenCalledWith(
      path.join(external, "secret.ts"),
      expect.any(Number),
    );
  });

  it("does not canonicalize external or symlink import candidates during Program resolution", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "system-graph-host-boundary-test-"),
    );
    const external = await fs.mkdtemp(
      path.join(os.tmpdir(), "system-graph-host-external-test-"),
    );
    temporaryRoots.push(root, external);
    await fs.mkdir(path.join(root, "agents", "coordinator"), {
      recursive: true,
    });
    await fs.mkdir(path.join(root, "shared"), { recursive: true });
    await fs.writeFile(
      path.join(external, "secret.ts"),
      'ctx.sapiom.agents.run({ definition: "outside" });\n',
    );
    await fs.symlink(
      path.join(external, "secret.ts"),
      path.join(root, "shared", "link.ts"),
    );
    const externalSpecifier = path
      .relative(path.join(root, "agents", "coordinator"), path.join(external, "secret"))
      .split(path.sep)
      .join(path.posix.sep);
    await fs.writeFile(
      path.join(root, "agents", "coordinator", "index.ts"),
      `import "${externalSpecifier}";\nimport "../../shared/link";\n`,
    );
    const probed: string[] = [];
    setCanonicalGraphPathProbeForTest((candidate) => probed.push(candidate));

    const result = await createSystemGraphPackageCompilerResult({
      packageRoot: root,
    });
    result.program.getSemanticDiagnostics();

    expect(
      probed.filter(
        (candidate) =>
          candidate.startsWith(external) ||
          candidate.includes(`${path.sep}shared${path.sep}link`),
      ),
    ).toEqual([]);
    expect([...result.sources.keys()]).not.toContain(
      path.join(root, "shared", "link.ts"),
    );
  });

  it("resolves computed methods, method aliases, assignments, and destructuring", async () => {
    const [coordinator] = await packageWithCallers(
      {
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

const method = "run" as const;
agents[method]({ definition: "computed" });

const runAlias = agents.run;
runAlias({ definition: "variable" });

let launchAlias: typeof agents.launch;
launchAlias = agents.launch;
launchAlias({ definition: "assigned" });

const { run, launch: kick } = agents;
run({ definition: "destructured" });
kick({ definition: "renamed" });

const picked = Math.random() > 0.5 ? "run" : "bogus";
agents[picked]({ definition: "never-guessed" });
`,
      },
      ["coordinator"],
    );

    const result = await new SourceAgentInvocationProvider().listInvocations(
      coordinator!,
    );

    expect(result.invocations).toEqual([
      {
        target: "computed",
        mode: "blocking",
        evidence: [{ file: "index.ts", line: 5, column: 1 }],
      },
      {
        target: "variable",
        mode: "blocking",
        evidence: [{ file: "index.ts", line: 8, column: 1 }],
      },
      {
        target: "assigned",
        mode: "async",
        evidence: [{ file: "index.ts", line: 12, column: 1 }],
      },
      {
        target: "destructured",
        mode: "blocking",
        evidence: [{ file: "index.ts", line: 15, column: 1 }],
      },
      {
        target: "renamed",
        mode: "async",
        evidence: [{ file: "index.ts", line: 16, column: 1 }],
      },
    ]);
    expect(result.warnings).toEqual([
      {
        code: "dynamic-target",
        mode: "blocking",
        evidence: { file: "index.ts", line: 19, column: 1 },
      },
      {
        code: "dynamic-target",
        mode: "async",
        evidence: { file: "index.ts", line: 19, column: 1 },
      },
    ]);
  });

  it("degrades reassigned method aliases instead of applying the final write globally", async () => {
    const [coordinator] = await packageWithCallers(
      {
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

let invoke = agents.run;
invoke({ definition: "before" });
invoke = agents.launch;
invoke({ definition: "after" });
`,
      },
      ["coordinator"],
    );

    const result = await new SourceAgentInvocationProvider().listInvocations(
      coordinator!,
    );

    expect(result.invocations).toEqual([]);
    expect(result.warnings).toEqual([
      {
        code: "dynamic-target",
        mode: "blocking",
        evidence: { file: "index.ts", line: 5, column: 1 },
      },
      {
        code: "dynamic-target",
        mode: "async",
        evidence: { file: "index.ts", line: 5, column: 1 },
      },
      {
        code: "dynamic-target",
        mode: "blocking",
        evidence: { file: "index.ts", line: 7, column: 1 },
      },
      {
        code: "dynamic-target",
        mode: "async",
        evidence: { file: "index.ts", line: 7, column: 1 },
      },
    ]);
  });

  it("degrades method aliases reassigned to local values without guessing edges", async () => {
    const [coordinator] = await packageWithCallers(
      {
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

const local = () => null;
let invoke = agents.run;
invoke = local;
invoke({ definition: "not-an-agent-call" });
`,
      },
      ["coordinator"],
    );

    const result = await new SourceAgentInvocationProvider().listInvocations(
      coordinator!,
    );

    expect(result.invocations).toEqual([]);
    expect(result.warnings).toEqual([
      {
        code: "dynamic-target",
        mode: "blocking",
        evidence: { file: "index.ts", line: 7, column: 1 },
      },
      {
        code: "dynamic-target",
        mode: "async",
        evidence: { file: "index.ts", line: 7, column: 1 },
      },
    ]);
  });

  it("does not emit wrapper internals as duplicate evidence for the same basis", async () => {
    const [coordinator] = await packageWithCallers(
      {
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

function runResearch() {
  return agents.run({ definition: "research" });
}

await runResearch();
`,
      },
      ["coordinator"],
    );

    const result = await new SourceAgentInvocationProvider().listInvocations(
      coordinator!,
    );

    expect(result.invocations).toEqual([
      {
        target: "research",
        mode: "blocking",
        evidence: [{ file: "index.ts", line: 8, column: 7 }],
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("uses wrapper parameter symbols instead of shadowed names", async () => {
    const [coordinator] = await packageWithCallers(
      {
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

function runNamed(definition: string) {
  {
    const definition = "shadowed-local";
    return agents.run({ definition });
  }
}

await runNamed("argument-target");
`,
      },
      ["coordinator"],
    );

    const result = await new SourceAgentInvocationProvider().listInvocations(
      coordinator!,
    );

    expect(result.invocations).toEqual([
      {
        target: "shadowed-local",
        mode: "blocking",
        evidence: [{ file: "index.ts", line: 11, column: 7 }],
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("keeps dynamically invoked wrapper targets partial without guessing an edge", async () => {
    const [coordinator] = await packageWithCallers(
      {
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

const target = Math.random() > 0.5 ? "research" : "growth";
function runNamed(definition: string) {
  return agents.run({ definition });
}

await runNamed(target);
`,
      },
      ["coordinator"],
    );

    const result = await new SourceAgentInvocationProvider().listInvocations(
      coordinator!,
    );

    expect(result.invocations).toEqual([]);
    expect(result.warnings).toEqual([
      {
        code: "dynamic-target",
        mode: "blocking",
        evidence: { file: "index.ts", line: 9, column: 7 },
      },
    ]);
  });
});

describe("CachedAgentInvocationProvider", () => {
  it("coalesces and reuses unchanged caller extraction", async () => {
    const caller = await callerWithSource("export const value = 1;\n");
    const inner: AgentInvocationProvider = {
      listInvocations: vi.fn(async () => ({
        invocations: [],
        warnings: [],
      })),
    };
    const fingerprint = vi.fn(async () => "fingerprint-one");
    const provider = new CachedAgentInvocationProvider(inner, fingerprint);

    const first = provider.listInvocations(caller);
    await expect(provider.listInvocations(caller)).resolves.toEqual(
      await first,
    );
    await provider.listInvocations(caller);

    expect(inner.listInvocations).toHaveBeenCalledTimes(1);
    expect(fingerprint).toHaveBeenCalledTimes(3);
  });

  it("rescans only after the caller fingerprint changes", async () => {
    const caller = await callerWithSource("export const value = 1;\n");
    const inner: AgentInvocationProvider = {
      listInvocations: vi.fn(async () => ({
        invocations: [],
        warnings: [],
      })),
    };
    const fingerprint = vi
      .fn()
      .mockResolvedValueOnce("one")
      .mockResolvedValueOnce("two");
    const provider = new CachedAgentInvocationProvider(inner, fingerprint);

    await provider.listInvocations(caller);
    await provider.listInvocations(caller);

    expect(inner.listInvocations).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached package evidence when a shared helper changes", async () => {
    const [coordinator] = await packageWithCallers(
      {
        "shared/router.ts": `
import { agents } from "@sapiom/tools";
export function route() {
  return agents.run({ definition: "first" });
}
`,
        "agents/coordinator/index.ts": `
import { route } from "../../shared/router";
await route();
`,
      },
      ["coordinator"],
    );
    const provider = new CachedAgentInvocationProvider(
      new SourceAgentInvocationProvider(),
    );

    const first = await provider.listInvocations(coordinator!);
    await fs.writeFile(
      path.resolve(coordinator!.sourceRoot, "../../shared/router.ts"),
      `
import { agents } from "@sapiom/tools";
export function route() {
  return agents.run({ definition: "second" });
}
`,
    );
    const second = await provider.listInvocations(coordinator!);

    expect(first.invocations[0]?.target).toBe("first");
    expect(second.invocations[0]?.target).toBe("second");
  });

  it("invalidates cached package evidence when admitted tools declarations change", async () => {
    const [coordinator] = await packageWithCallers(
      {
        "node_modules/@sapiom/tools/index.d.ts": `
export declare const agents: {
  run(spec: { definition: string }): Promise<unknown>;
};
`,
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";
await agents.run({ definition: "research" });
`,
      },
      ["coordinator"],
    );
    const provider = new CachedAgentInvocationProvider(
      new SourceAgentInvocationProvider(),
    );

    const first = await provider.listInvocations(coordinator!);
    await fs.writeFile(
      path.resolve(coordinator!.sourceRoot, "../../node_modules/@sapiom/tools/index.d.ts"),
      `
export declare const agents: {
  run(spec: { definition: string; version?: 2 }): Promise<unknown>;
};
`,
    );
    const second = await provider.listInvocations(coordinator!);

    expect(second.invocations).toEqual(first.invocations);
    expect(second.sourceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.sourceFingerprint).not.toBe(first.sourceFingerprint);
  });

  it("does not retain a failed caller result", async () => {
    const caller = await callerWithSource("export const value = 1;\n");
    const inner: AgentInvocationProvider = {
      listInvocations: vi
        .fn()
        .mockRejectedValueOnce(new Error("not installed"))
        .mockResolvedValueOnce({ invocations: [], warnings: [] }),
    };
    const provider = new CachedAgentInvocationProvider(
      inner,
      async () => "same",
    );

    await expect(provider.listInvocations(caller)).rejects.toThrow(
      "not installed",
    );
    await expect(provider.listInvocations(caller)).resolves.toEqual({
      invocations: [],
      warnings: [],
    });
    expect(inner.listInvocations).toHaveBeenCalledTimes(2);
  });

  it("evicts removed callers while preserving retained callers", async () => {
    const first = await callerWithSource("export const first = 1;\n");
    const second = await callerWithSource("export const second = 1;\n");
    const inner: AgentInvocationProvider = {
      listInvocations: vi.fn(async () => ({
        invocations: [],
        warnings: [],
      })),
    };
    const provider = new CachedAgentInvocationProvider(
      inner,
      async () => "same",
    );
    await provider.listInvocations(first);
    await provider.listInvocations(second);

    provider.retainCallers([second]);
    await provider.listInvocations(first);
    await provider.listInvocations(second);

    expect(inner.listInvocations).toHaveBeenCalledTimes(3);
  });

  it("runs background invocation extraction with a fixed concurrency cap", async () => {
    const callers = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        callerWithSource(`export const value = ${index};\n`),
      ),
    );
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const onChange = vi.fn();
    const inner: AgentInvocationProvider = {
      listInvocations: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return EMPTY_RESULT;
      }),
    };
    const provider = new CachedAgentInvocationProvider(
      inner,
      async () => "unused",
      { concurrency: 4, onChange },
    );

    provider.startInvocations(callers);
    await vi.waitFor(() => {
      expect(inner.listInvocations).toHaveBeenCalledTimes(4);
    });
    expect(maxActive).toBe(4);

    while (releases.length > 0 || active > 0) {
      releases.splice(0).forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await vi.waitFor(() => {
      expect(inner.listInvocations).toHaveBeenCalledTimes(9);
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    expect(maxActive).toBe(4);
    expect(
      callers.every(
        (caller) => provider.peekInvocations(caller)?.status === "ready",
      ),
    ).toBe(true);
  });

  it("discards a superseded result and runs the fresh generation afterward", async () => {
    const caller = await callerWithSource("export const value = 1;\n");
    const first = deferred<AgentInvocationProviderResult>();
    const inner: AgentInvocationProvider = {
      listInvocations: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValueOnce({
          invocations: [
            {
              target: "fresh",
              mode: "blocking",
              evidence: [{ file: "index.ts", line: 1, column: 1 }],
            },
          ],
          warnings: [],
        }),
    };
    const onChange = vi.fn();
    const provider = new CachedAgentInvocationProvider(
      inner,
      async () => "unused",
      { concurrency: 1, onChange },
    );

    provider.startInvocations([caller]);
    await vi.waitFor(() =>
      expect(inner.listInvocations).toHaveBeenCalledTimes(1),
    );
    provider.invalidateSource(caller.sourceRoot);
    provider.startInvocations([caller]);
    first.resolve({
      invocations: [
        {
          target: "stale",
          mode: "blocking",
          evidence: [{ file: "index.ts", line: 1, column: 1 }],
        },
      ],
      warnings: [],
    });

    await vi.waitFor(() => {
      expect(inner.listInvocations).toHaveBeenCalledTimes(2);
      expect(
        provider.peekInvocations(caller)?.result.invocations[0]?.target,
      ).toBe("fresh");
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps failures stable until explicit Retry rearms them", async () => {
    const caller = await callerWithSource("export const value = 1;\n");
    const inner: AgentInvocationProvider = {
      listInvocations: vi
        .fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce(EMPTY_RESULT),
    };
    const provider = new CachedAgentInvocationProvider(inner);

    provider.startInvocations([caller]);
    await vi.waitFor(() => {
      expect(provider.peekInvocations(caller)?.status).toBe("failed");
    });
    provider.startInvocations([caller]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inner.listInvocations).toHaveBeenCalledTimes(1);

    provider.retryFailed(caller.sourceRoot);
    provider.startInvocations([caller]);
    await vi.waitFor(() => {
      expect(provider.peekInvocations(caller)?.status).toBe("ready");
    });
    expect(inner.listInvocations).toHaveBeenCalledTimes(2);
  });

  it("rearms an incomplete bounded scan only on explicit Retry", async () => {
    const caller = await callerWithSource("export const value = 1;\n");
    const inner: AgentInvocationProvider = {
      listInvocations: vi
        .fn()
        .mockResolvedValueOnce({ ...EMPTY_RESULT, complete: false })
        .mockResolvedValueOnce({ ...EMPTY_RESULT, complete: true }),
    };
    const provider = new CachedAgentInvocationProvider(inner);

    provider.startInvocations([caller]);
    await vi.waitFor(() => {
      expect(provider.peekInvocations(caller)?.result.complete).toBe(false);
    });
    provider.startInvocations([caller]);
    expect(inner.listInvocations).toHaveBeenCalledTimes(1);

    provider.retryFailed(caller.sourceRoot);
    provider.startInvocations([caller]);
    await vi.waitFor(() => {
      expect(provider.peekInvocations(caller)?.result.complete).toBe(true);
    });
    expect(inner.listInvocations).toHaveBeenCalledTimes(2);
  });

  it("caps retained watcher observations fairly and degrades overflow", async () => {
    const callers = await Promise.all([
      callerWithSource("export const first = 1;\n"),
      callerWithSource("export const second = 2;\n"),
    ]);
    const inner: AgentInvocationProvider = {
      listInvocations: vi.fn(async (caller) => ({
        ...EMPTY_RESULT,
        complete: true,
        observedPaths: Array.from({ length: 6_000 }, (_, index) =>
          path.join(caller.sourceRoot, `observed-${index}.ts`),
        ),
      })),
    };
    const provider = new CachedAgentInvocationProvider(inner);

    provider.startInvocations(callers);
    await vi.waitFor(() => {
      expect(
        callers.every(
          (caller) =>
            provider.peekInvocations(caller)?.result.complete === false,
        ),
      ).toBe(true);
    });
    const observations = provider.invocationObservations();

    expect(observations).toHaveLength(2);
    expect(observations.map((entry) => entry.paths.length)).toEqual([
      5_000, 5_000,
    ]);
  });

  it("notifies every retained root when global observation coverage changes", async () => {
    const callers = await Promise.all([
      callerWithSource("export const first = 1;\n"),
      callerWithSource("export const second = 2;\n"),
    ]);
    const inner: AgentInvocationProvider = {
      listInvocations: vi.fn(async (caller) => ({
        ...EMPTY_RESULT,
        complete: true,
        observedPaths: Array.from({ length: 6_000 }, (_, index) =>
          path.join(caller.sourceRoot, `observed-${index}.ts`),
        ),
      })),
    };
    const onChange = vi.fn();
    const provider = new CachedAgentInvocationProvider(
      inner,
      async () => "unused",
      { onChange },
    );

    provider.startInvocations([callers[0]!]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(provider.peekInvocations(callers[0]!)?.result.complete).toBe(true);
    onChange.mockClear();

    provider.startInvocations(callers);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.flat(2)).toEqual(
      expect.arrayContaining(callers.map((caller) => caller.sourceRoot)),
    );
    expect(provider.peekInvocations(callers[0]!)?.result.complete).toBe(false);
    onChange.mockClear();

    provider.retainCallers([callers[0]!]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith([callers[0]!.sourceRoot]);
    expect(provider.peekInvocations(callers[0]!)?.result.complete).toBe(true);
  });

  it("does not notify for a settled result invalidated before its batch flush", async () => {
    const callers = await Promise.all([
      callerWithSource("export const fast = 1;\n"),
      callerWithSource("export const slow = 2;\n"),
    ]);
    const slow = deferred<AgentInvocationProviderResult>();
    const inner: AgentInvocationProvider = {
      listInvocations: vi
        .fn()
        .mockResolvedValueOnce(EMPTY_RESULT)
        .mockImplementationOnce(() => slow.promise),
    };
    const onChange = vi.fn();
    const provider = new CachedAgentInvocationProvider(
      inner,
      async () => "unused",
      { concurrency: 2, onChange, changeBatchMs: 50 },
    );

    provider.startInvocations(callers);
    await vi.waitFor(() => {
      expect(provider.peekInvocations(callers[0]!)?.status).toBe("ready");
    });
    provider.invalidateScope(os.tmpdir());
    slow.resolve(EMPTY_RESULT);
    await new Promise((resolve) => setTimeout(resolve, 70));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("publishes a settled workspace while an unrelated task remains held", async () => {
    const callers = await Promise.all([
      callerWithSource("export const quick = 1;\n"),
      callerWithSource("export const held = 2;\n"),
    ]);
    const held = deferred<AgentInvocationProviderResult>();
    const inner: AgentInvocationProvider = {
      listInvocations: vi
        .fn()
        .mockResolvedValueOnce(EMPTY_RESULT)
        .mockImplementationOnce(() => held.promise),
    };
    const onChange = vi.fn();
    const provider = new CachedAgentInvocationProvider(
      inner,
      async () => "unused",
      { concurrency: 2, onChange },
    );

    provider.startInvocations(callers);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));

    expect(onChange).toHaveBeenLastCalledWith([callers[0]!.sourceRoot]);
    expect(provider.peekInvocations(callers[0]!)?.status).toBe("ready");
    expect(provider.peekInvocations(callers[1]!)).toBeUndefined();

    held.resolve(EMPTY_RESULT);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
  });
});
