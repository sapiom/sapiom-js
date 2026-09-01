import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  projectPackageGraphEvidence,
  type PackageInventory,
  type PackageInventoryAgent,
} from "@sapiom/agent";

import type { AgentInventoryItem } from "./system-graph-inventory.js";
import {
  createSystemGraphPackageCompilerResult,
  type SystemGraphPackageCompilerResult,
} from "./system-graph-relationships.js";
import {
  analyzeStaticDataflow,
  StaticDataflowSummaryCache,
  STATIC_DATAFLOW_EVIDENCE_PRODUCER,
} from "./system-graph-static-dataflow-evidence.js";

const REVISION = `sha256:${"a".repeat(64)}` as const;
const temporaryRoots: string[] = [];

interface AgentFixture {
  context: AgentInventoryItem;
  public: PackageInventoryAgent;
}

function agent(
  root: string,
  agentKey: string,
  aliases: readonly string[] = [agentKey],
): AgentFixture {
  return {
    context: {
      agentKey,
      identityStatus: "canonical",
      definitionId: null,
      definitionSlug: null,
      label: agentKey,
      resolutionAliases: [...aliases],
      sourceRoot: path.join(root, "agents", agentKey),
      workflowPath: path.join(root, "agents", agentKey),
      path: `agents/${agentKey}`,
      entrypoint: "index.ts",
    },
    public: {
      agentKey,
      identityStatus: "canonical",
      path: `agents/${agentKey}`,
      entrypoint: "index.ts",
    },
  };
}

function inventory(fixtures: readonly AgentFixture[]): PackageInventory {
  return {
    protocol: 1,
    version: {
      kind: "working-tree",
      workspaceKey: "workspace-dataflow",
      revision: REVISION,
    },
    status: "complete",
    agents: fixtures.map((fixture) => fixture.public),
  };
}

async function writeFixture(
  files: Record<string, string>,
  agentKeys: readonly string[] = ["coordinator", "research", "growth", "sales"],
): Promise<{
  inventory: PackageInventory;
  agents: AgentInventoryItem[];
  compiler: SystemGraphPackageCompilerResult;
}> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "static-dataflow-evidence-"),
  );
  temporaryRoots.push(root);
  const toolsRoot = path.join(root, "node_modules", "@sapiom", "tools");
  await fs.mkdir(toolsRoot, { recursive: true });
  await fs.writeFile(
    path.join(toolsRoot, "package.json"),
    JSON.stringify({ name: "@sapiom/tools", types: "index.d.ts" }),
  );
  await fs.writeFile(
    path.join(toolsRoot, "index.d.ts"),
    `
export declare const agents: {
  run(spec: { definition: string; input?: unknown }): Promise<unknown>;
  launch(spec: { definition: string; input?: unknown }): Promise<unknown>;
};
`,
  );
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }
  const fixtures = agentKeys.map((key) => agent(root, key));
  const compiler = await createSystemGraphPackageCompilerResult({
    packageRoot: root,
  });
  return {
    inventory: inventory(fixtures),
    agents: fixtures.map((fixture) => fixture.context),
    compiler,
  };
}

async function analyze(
  files: Record<string, string>,
  agentKeys?: readonly string[],
) {
  const fixture = await writeFixture(files, agentKeys);
  return {
    ...fixture,
    result: analyzeStaticDataflow(fixture),
  };
}

async function connectors(files: Record<string, string>) {
  const { inventory: packageInventory, result } = await analyze(files);
  return projectPackageGraphEvidence(packageInventory, [
    result.result,
  ]).connectors;
}

async function edgePairs(files: Record<string, string>) {
  return (await connectors(files)).map(({ fromAgentKey, toAgentKey }) => [
    fromAgentKey,
    toAgentKey,
  ]);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("analyzeStaticDataflow", () => {
  it("emits one canonical Research output to Growth input feeds edge through awaits and sync transforms", async () => {
    const analysis = await analyze({
      "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

function formatReport(report) {
  const { summary } = report;
  return { body: summary, raw: report };
}

export async function run() {
  const research = await agents.run({ definition: "research" });
  const formatted = formatReport(research);
  await agents.run({ definition: "growth", input: formatted });
}
`,
    });

    expect(analysis.result.complete).toBe(true);
    expect(analysis.result.result).toMatchObject({
      protocol: 1,
      kind: "static-result",
      producer: STATIC_DATAFLOW_EVIDENCE_PRODUCER,
      outcome: "success",
      coverage: { status: "complete" },
    });
    expect(
      analysis.result.result.evidence.map((evidence) => ({
        fromAgentKey: evidence.fromAgentKey,
        toAgentKey: evidence.toAgentKey,
        relation: evidence.relation,
        basis: evidence.basis,
      })),
    ).toEqual([
      {
        fromAgentKey: "research",
        toAgentKey: "growth",
        relation: "feeds",
        basis: "static-dataflow",
      },
    ]);
  });

  it("keeps sibling properties independent and selects only the addressed property", async () => {
    expect(
      await edgePairs({
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const research = await agents.run({ definition: "research" });
  const sales = await agents.run({ definition: "sales" });
  const payload = { research, sales };
  await agents.run({ definition: "growth", input: payload.sales });
}
`,
      }),
    ).toEqual([["sales", "growth"]]);
  });

  it("preserves root agent output through direct property/index access and destructuring", async () => {
    expect(
      await edgePairs({
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const output = await agents.run({ definition: "research" });
  const { summary } = output;
  await agents.run({ definition: "growth", input: output.summary });
  await agents.run({ definition: "sales", input: output[0] });
  await agents.run({ definition: "coordinator", input: summary });
}
`,
      }),
    ).toEqual([
      ["research", "coordinator"],
      ["research", "growth"],
      ["research", "sales"],
    ]);
  });

  it("preserves structured provenance through object and array rest selections", async () => {
    const analysis = await analyze({
      "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const output = await agents.run({ definition: "research" });
  const sales = await agents.run({ definition: "sales" });
  const { ignored, ...objectRest } = output;
  const [first, ...arrayRest] = output;
  const values = [sales, output];
  const [, ...reindexed] = values;
  await agents.run({ definition: "growth", input: objectRest.summary });
  await agents.run({ definition: "sales", input: arrayRest[0] });
  await agents.run({ definition: "coordinator", input: reindexed[0] });
}
`,
    });

    expect(analysis.result.complete).toBe(true);
    expect(analysis.result.cacheable).toBe(true);
    expect(
      projectPackageGraphEvidence(analysis.inventory, [
        analysis.result.result,
      ]).connectors.map(({ fromAgentKey, toAgentKey }) => [
        fromAgentKey,
        toAgentKey,
      ]),
    ).toEqual([
      ["research", "coordinator"],
      ["research", "growth"],
      ["research", "sales"],
    ]);
  });

  it("follows wrappers, re-exports, destructuring, construction, and literal routing keys", async () => {
    expect(
      (await connectors({
        "shared/helpers.ts": `
import { agents } from "@sapiom/tools";

export function submitGrowth({ result }) {
  return agents.launch({ definition: "growth", input: { payload: result } });
}

export function submitSales(report) {
  return agents.run({ definition: "sales", input: [report] });
}
`,
        "shared/router.ts": `
export { submitGrowth as growthWriter, submitSales } from "./helpers";
`,
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";
import { growthWriter, submitSales } from "../../shared/router";

const table = { growth: growthWriter, sales: submitSales };

export async function run() {
  const output = await agents.run({ definition: "research" });
  const envelope = { result: output, copy: { ...output } };
  table["growth"](envelope);
  table["sales"](envelope);
}
`,
      })).map(({ fromAgentKey, toAgentKey, relation, bases }) => ({
        fromAgentKey,
        toAgentKey,
        relation,
        bases,
      })),
    ).toEqual([
      {
        fromAgentKey: "research",
        toAgentKey: "growth",
        relation: "feeds",
        bases: ["static-dataflow"],
      },
      {
        fromAgentKey: "research",
        toAgentKey: "sales",
        relation: "feeds",
        bases: ["static-dataflow"],
      },
    ]);
  });

  it("does not fan out dynamic routing keys", async () => {
    const analysis = await analyze({
      "shared/helpers.ts": `
import { agents } from "@sapiom/tools";
export function submitGrowth(value) {
  return agents.run({ definition: "growth", input: value });
}
`,
      "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";
import { submitGrowth } from "../../shared/helpers";
const table = { growth: submitGrowth };
export async function run(route) {
  const output = await agents.run({ definition: "research" });
  table[route](output);
}
`,
    });

    expect(analysis.result.result.evidence).toEqual([]);
    expect(analysis.result.complete).toBe(false);
  });

  it("continues after fallthrough branches and merges returned branch values", async () => {
    expect(
      (await connectors({
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

function choose(flag, value) {
  if (flag) {
    return { payload: value };
  }
  const wrapped = { payload: value };
  return wrapped;
}

function fallthrough(flag, value) {
  if (flag) {
    const ignored = { other: value };
  }
  const wrapped = { payload: value };
  return wrapped;
}

export async function run(flag) {
  const output = await agents.run({ definition: "research" });
  await agents.run({ definition: "growth", input: choose(flag, output).payload });
  await agents.run({ definition: "sales", input: fallthrough(flag, output).payload });
}
`,
      })).map(({ fromAgentKey, toAgentKey }) => [fromAgentKey, toAgentKey]),
    ).toEqual([
      ["research", "growth"],
      ["research", "sales"],
    ]);
  });

  it("resolves aliased and spread invocation option objects through the shared checker seam", async () => {
    expect(
      (await connectors({
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const output = await agents.run({ definition: "research" });
  const base = { input: output };
  const options = { ...base, definition: "growth" };
  await agents.run(options);
}
`,
      })).map(({ fromAgentKey, toAgentKey }) => [fromAgentKey, toAgentKey]),
    ).toEqual([["research", "growth"]]);
  });

  it("uses last-write semantics for object spreads and invocation option input", async () => {
    expect(
      await edgePairs({
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const research = await agents.run({ definition: "research" });
  const sales = await agents.run({ definition: "sales" });
  const spread = { input: research, value: research };
  const options = { ...spread, definition: "growth", input: sales };
  const payload = { ...spread, value: sales };
  await agents.run(options);
  await agents.run({ definition: "growth", input: payload.value });
}
`,
      }),
    ).toEqual([["sales", "growth"]]);
  });

  it("does not guess complete evidence when a trailing unknown object spread may overwrite a key", async () => {
    const unsafe = await analyze({
      "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const research = await agents.run({ definition: "research" });
  const sales = await agents.run({ definition: "sales" });
  const payload = { value: sales, ...research };
  await agents.run({ definition: "growth", input: payload.value });
}
`,
    });
    expect(unsafe.result.complete).toBe(false);
    expect(unsafe.result.cacheable).toBe(false);
    expect(unsafe.result.result.evidence).toEqual([]);

    const safe = await analyze({
      "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const research = await agents.run({ definition: "research" });
  const sales = await agents.run({ definition: "sales" });
  const payload = { ...research, value: sales };
  await agents.run({ definition: "growth", input: payload.value });
}
`,
    });
    expect(safe.result.complete).toBe(true);
    expect(
      projectPackageGraphEvidence(safe.inventory, [
        safe.result.result,
      ]).connectors.map(({ fromAgentKey, toAgentKey }) => [
        fromAgentKey,
        toAgentKey,
      ]),
    ).toEqual([["sales", "growth"]]);
  });

  it("marks provenance-bearing unresolved option spreads partial without guessing overwritten input", async () => {
    const analysis = await analyze({
      "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run(extra) {
  const output = await agents.run({ definition: "research" });
  await agents.run({ definition: "growth", input: output, ...extra });
}
`,
    });

    expect(analysis.result.complete).toBe(false);
    expect(analysis.result.cacheable).toBe(false);
    expect(analysis.result.result.evidence).toEqual([]);
  });

  it("tracks statically addressed property and element assignments", async () => {
    expect(
      await edgePairs({
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const output = await agents.run({ definition: "research" });
  const holder = {};
  holder.value = output;
  await agents.run({ definition: "growth", input: holder.value });
}
`,
      }),
    ).toEqual([["research", "growth"]]);
    expect(
      await edgePairs({
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const output = await agents.run({ definition: "research" });
  const holder = {};
  holder["value"] = output;
  await agents.run({ definition: "growth", input: holder["value"] });
}
`,
      }),
    ).toEqual([["research", "growth"]]);
  });

  it("propagates property writes through aliases and nested assignment expressions", async () => {
    expect(
      await edgePairs({
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const research = await agents.run({ definition: "research" });
  const holder = {};
  const alias = holder;
  alias.value = research;
  await agents.run({ definition: "growth", input: holder.value });
}
`,
      }),
    ).toEqual([["research", "growth"]]);

    expect(
      await edgePairs({
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const research = await agents.run({ definition: "research" });
  const holder = {};
  const assigned = (holder.value = research);
  await agents.run({ definition: "growth", input: holder.value });
  await agents.run({ definition: "sales", input: assigned });
}
`,
      }),
    ).toEqual([
      ["research", "growth"],
      ["research", "sales"],
    ]);
  });

  it("degrades unsupported provenance-bearing writes and destructuring assignment forms", async () => {
    const supported = await analyze({
      "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const output = await agents.run({ definition: "research" });
  let value;
  ({ summary: value } = output);
  await agents.run({ definition: "growth", input: value });
}
`,
    });
    expect(supported.result.complete).toBe(true);
    expect(
      projectPackageGraphEvidence(supported.inventory, [
        supported.result.result,
      ]).connectors.map(({ fromAgentKey, toAgentKey }) => [
        fromAgentKey,
        toAgentKey,
      ]),
    ).toEqual([["research", "growth"]]);

    const unsupported = await analyze({
      "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run(key) {
  const output = await agents.run({ definition: "research" });
  const holder = {};
  holder[key] = output;
}
`,
    });
    expect(unsupported.result.complete).toBe(false);
    expect(unsupported.result.cacheable).toBe(false);
  });

  it("marks provenance-bearing unsupported conditions and dynamic switches partial", async () => {
    const condition = await analyze({
      "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const output = await agents.run({ definition: "research" });
  if (JSON.parse(JSON.stringify(output))) {
    return;
  }
}
`,
    });
    expect(condition.result.complete).toBe(false);
    expect(condition.result.cacheable).toBe(false);

    const dynamicSwitch = await analyze({
      "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const output = await agents.run({ definition: "research" });
  switch (output.kind) {
    case "growth":
      await agents.run({ definition: "growth", input: output });
      break;
  }
}
`,
    });
    expect(dynamicSwitch.result.complete).toBe(false);
    expect(dynamicSwitch.result.cacheable).toBe(false);
  });

  it("marks unsupported provenance-bearing loops partial without guessing loop body edges", async () => {
    const whileLoop = await analyze({
      "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const output = await agents.run({ definition: "research" });
  while (output) {
    await agents.run({ definition: "growth", input: output });
  }
}
`,
    });
    expect(whileLoop.result.complete).toBe(false);
    expect(whileLoop.result.cacheable).toBe(false);
    expect(whileLoop.result.result.evidence).toEqual([]);

    const forOf = await analyze({
      "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const output = await agents.run({ definition: "research" });
  for (const item of [output]) {
    await agents.run({ definition: "growth", input: item });
  }
}
`,
    });
    expect(forOf.result.complete).toBe(false);
    expect(forOf.result.cacheable).toBe(false);
    expect(forOf.result.result.evidence).toEqual([]);

    const safe = await analyze({
      "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  for (const item of ["static"]) {
    await agents.run({ definition: "growth", input: item });
  }
}
`,
    });
    expect(safe.result.complete).toBe(true);
    expect(safe.result.result.evidence).toEqual([]);
  });

  it("preserves positional identity through known array spreads and degrades unknown-length spreads", async () => {
    expect(
      await edgePairs({
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const research = await agents.run({ definition: "research" });
  const sales = await agents.run({ definition: "sales" });
  const values = [research, sales];
  const combined = [...values];
  await agents.run({ definition: "growth", input: combined[1] });
}
`,
      }),
    ).toEqual([["sales", "growth"]]);

    const unknown = await analyze({
      "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const output = await agents.run({ definition: "research" });
  const combined = [...output];
  await agents.run({ definition: "growth", input: combined[0] });
}
`,
    });
    expect(unknown.result.complete).toBe(false);
    expect(unknown.result.cacheable).toBe(false);
    expect(unknown.result.result.evidence).toEqual([]);
  });

  it("models statically bounded switch branches with fallthrough environment merging", async () => {
    expect(
      await edgePairs({
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

function route(kind, value) {
  let selected;
  switch (kind) {
    case "growth":
      selected = { payload: value };
      break;
    default:
      selected = { payload: value };
  }
  return selected;
}

export async function run() {
  const output = await agents.run({ definition: "research" });
  await agents.run({ definition: "growth", input: route("growth", output).payload });
}
`,
      }),
    ).toEqual([["research", "growth"]]);
  });

  it("prefers canonical agent keys before stale compatibility aliases", async () => {
    const fixture = await writeFixture(
      {
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const output = await agents.run({ definition: "research" });
  await agents.run({ definition: "growth", input: output });
}
`,
      },
      ["coordinator", "research", "growth", "sales"],
    );
    const withStaleAlias = {
      ...fixture,
      agents: fixture.agents.map((item) =>
        item.agentKey === "sales"
          ? { ...item, resolutionAliases: ["sales", "growth"] }
          : item,
      ),
    };
    const result = analyzeStaticDataflow(withStaleAlias);
    expect(
      projectPackageGraphEvidence(withStaleAlias.inventory, [
        result.result,
      ]).connectors.map(({ fromAgentKey, toAgentKey }) => [
        fromAgentKey,
        toAgentKey,
      ]),
    ).toEqual([["research", "growth"]]);
  });

  it("keys duplicate function names across files by checker-resolved declaration identity", async () => {
    expect(
      (await connectors({
        "shared/a.ts": `
export function format(value) {
  return { picked: value };
}
`,
        "shared/b.ts": `
export function format(value) {
  return { ignored: value };
}
`,
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";
import { format as formatA } from "../../shared/a";
import { format as formatB } from "../../shared/b";

export async function run() {
  const research = await agents.run({ definition: "research" });
  const sales = await agents.run({ definition: "sales" });
  await agents.run({ definition: "growth", input: formatA(research).picked });
  await agents.run({ definition: "growth", input: formatB(sales).picked });
}
`,
      })).map(({ fromAgentKey, toAgentKey }) => [fromAgentKey, toAgentKey]),
    ).toEqual([["research", "growth"]]);
  });

  it("does not treat launch handles as returned agent output provenance", async () => {
    expect(
      (await connectors({
        "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";

export async function run() {
  const handle = agents.launch({ definition: "research" });
  await agents.run({ definition: "growth", input: handle });
}
`,
      })).map(({ fromAgentKey, toAgentKey }) => [fromAgentKey, toAgentKey]),
    ).toEqual([]);
  });

  it("marks opaque stores, constructors, unsupported transforms, dynamic targets, unresolved targets, and cycles partial without guessed edges", async () => {
    const analysis = await analyze({
      "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";
const queue = [];
class Box { constructor(value) { this.value = value; } }
function loop(value) {
  return loop(value);
}
export async function run(name) {
  const output = await agents.run({ definition: "research" });
  queue.push(output);
  new Box(output);
  const transformed = JSON.parse(JSON.stringify(output));
  await agents.run({ definition: "growth", input: transformed });
  await agents.run({ definition: name, input: output });
  await agents.run({ definition: "missing", input: output });
  loop(output);
}
`,
    });

    expect(analysis.result.complete).toBe(false);
    expect(analysis.result.result.coverage.status).toBe("partial");
    expect(analysis.result.result.evidence).toEqual([]);
    expect(
      new Set(
        analysis.result.result.diagnostics.map((diagnostic) => diagnostic.code),
      ),
    ).toEqual(new Set(["dynamic-target", "incomplete-analysis"]));
  });

  it("keeps target-resolution identity in cache keys and never retains partial results", async () => {
    const first = await writeFixture({
      "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";
export async function run() {
  const output = await agents.run({ definition: "research" });
  await agents.run({ definition: "writer", input: output });
}
`,
    });
    const cache = new StaticDataflowSummaryCache();
    const firstWithAlias = {
      ...first,
      agents: first.agents.map((item) =>
        item.agentKey === "growth"
          ? { ...item, resolutionAliases: ["growth", "writer"] }
          : item,
      ),
    };
    const secondWithAlias = {
      ...first,
      agents: first.agents.map((item) =>
        item.agentKey === "sales"
          ? { ...item, resolutionAliases: ["sales", "writer"] }
          : item,
      ),
    };

    const growth = cache.getOrAnalyze(firstWithAlias);
    const sales = cache.getOrAnalyze(secondWithAlias);
    expect(
      projectPackageGraphEvidence(first.inventory, [growth.result])
        .connectors[0]?.toAgentKey,
    ).toBe("growth");
    expect(
      projectPackageGraphEvidence(first.inventory, [sales.result])
        .connectors[0]?.toAgentKey,
    ).toBe("sales");
    expect(sales).not.toBe(growth);

    const partial = await writeFixture({
      "agents/coordinator/index.ts": `
import { agents } from "@sapiom/tools";
export async function run(route) {
  const output = await agents.run({ definition: "research" });
  const table = { growth: (value) => agents.run({ definition: "growth", input: value }) };
  table[route](output);
}
`,
    });
    expect(cache.getOrAnalyze(partial)).not.toBe(cache.getOrAnalyze(partial));
  });
});
