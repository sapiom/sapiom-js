import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_SOURCE_MAX_BYTES_PER_CANDIDATE,
  AGENT_SOURCE_MAX_BYTES_PER_SCAN,
  AGENT_SOURCE_MAX_IMPORT_DEPTH,
  AGENT_SOURCE_MAX_MODULES_PER_CANDIDATE,
  AGENT_SOURCE_MAX_MODULES_PER_SCAN,
  AGENT_SOURCE_MODULE_CACHE_MAX_ENTRIES,
  AgentSourceDiscovery,
  AgentSourceModuleCache,
  AgentSourceScanBudget,
} from "./agent-source-discovery.js";

const execFileAsync = promisify(execFile);

async function write(
  root: string,
  relativePath: string,
  source: string,
): Promise<void> {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source);
}

function padSourceToBytes(source: string, bytes: number): string {
  const opening = "\n/*";
  const closing = "*/";
  const padding = bytes - Buffer.byteLength(source + opening + closing);
  if (padding < 0) throw new Error("source exceeds requested fixture size");
  return `${source}${opening}${"x".repeat(padding)}${closing}`;
}

describe("AgentSourceDiscovery", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-source-agent-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    {
      label: "named current export",
      source: `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "  payments  ", entry: "start", steps: {} });`,
      name: "payments",
    },
    {
      label: "aliased current default export",
      source: `import { defineAgent as create } from "@sapiom/agent";
const factory = create;
export default factory({ name: \`billing\`, entry: "start", steps: {} });`,
      name: "billing",
    },
    {
      label: "current namespace export",
      source: `import * as sdk from "@sapiom/agent";
export const agent = sdk.defineAgent({ name: "support", entry: "start", steps: {} });`,
      name: "support",
    },
    {
      label: "legacy named export",
      source: `import { defineOrchestration as define } from "@sapiom/orchestration";
const workflow = define({ name: "legacy", entry: "start", steps: {} });
export { workflow as orchestration };`,
      name: "legacy",
    },
  ])("proves $label without executing it", async ({ source, name }) => {
    await write(root, "index.ts", source);

    const result = await new AgentSourceDiscovery().inspectCandidate(root);

    expect(result).toMatchObject({ status: "agent", name, modules: 1 });
  });

  it.each([
    {
      label: "literal computed name",
      properties: `["name"]: "computed"`,
      name: "computed",
    },
    {
      label: "unknown computed property before a final static name",
      properties: `[key]: "unknown", name: "final"`,
      name: "final",
    },
    {
      label: "unknown computed property after a static name",
      properties: `name: "overridable", [key]: "unknown"`,
      name: null,
    },
  ])("handles $label conservatively", async ({ properties, name }) => {
    await write(
      root,
      "index.ts",
      `import { defineAgent } from "@sapiom/agent";
declare const key: string;
export const agent = defineAgent({ ${properties} });`,
    );

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "agent", name });
  });

  it("resolves named/default imports, factory aliases, and re-exports", async () => {
    await write(
      root,
      "factory.ts",
      `export { defineAgent as makeAgent } from "@sapiom/agent";`,
    );
    await write(
      root,
      "agent.ts",
      `import { makeAgent } from "./factory";
const defined = makeAgent({ name: "reexported", entry: "start", steps: {} });
export { defined as default };`,
    );
    await write(
      root,
      "barrel.ts",
      `export { default as workflow } from "./agent.ts";`,
    );
    await write(
      root,
      "index.ts",
      `export { workflow as default } from "./barrel";`,
    );

    const result = await new AgentSourceDiscovery().inspectCandidate(root);

    expect(result).toMatchObject({
      status: "agent",
      name: "reexported",
      modules: 4,
    });
  });

  it.each([
    [".js", ".ts"],
    [".jsx", ".tsx"],
    [".mjs", ".mts"],
    [".cjs", ".cts"],
  ])(
    "maps a NodeNext %s specifier back to a TypeScript %s module",
    async (specifierExtension, sourceExtension) => {
      await write(
        root,
        `agent${sourceExtension}`,
        `import { defineAgent as make } from "@sapiom/agent";
export const agent = make({ name: "nodenext", entry: "start", steps: {} });`,
      );
      await write(
        root,
        "index.ts",
        `export { agent as default } from "./agent${specifierExtension}";`,
      );

      await expect(
        new AgentSourceDiscovery().inspectCandidate(root),
      ).resolves.toMatchObject({ status: "agent", name: "nodenext" });
    },
  );

  it("does not resolve a NodeNext .jsx specifier to a .ts module", async () => {
    await write(
      root,
      "agent.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "wrong-extension" });`,
    );
    await write(root, "index.ts", `export { agent } from "./agent.jsx";`);

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "incomplete" });
  });

  it("continues relative resolution past ordinary non-file candidates", async () => {
    await fs.mkdir(path.join(root, "agent.ts"));
    await write(
      root,
      "agent.tsx",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "tsx-fallback" });`,
    );
    await write(root, "index.ts", `export { agent } from "./agent.js";`);
    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "agent", name: "tsx-fallback" });

    await fs.rm(path.join(root, "agent.ts"), { recursive: true });
    await fs.rm(path.join(root, "agent.tsx"));
    await fs.mkdir(path.join(root, "agent"), { recursive: true });
    await write(
      root,
      "agent/index.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "index-fallback" });`,
    );
    await write(root, "index.ts", `export { agent } from "./agent";`);
    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "agent", name: "index-fallback" });
  });

  it.each([
    `export * from "zod";`,
    `export * from "zod";
import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "local", entry: "start", steps: {} });`,
  ])("fails closed for an unresolved external export-star", async (source) => {
    await write(root, "index.ts", source);

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "incomplete" });
  });

  it.each([
    {
      label: "import-equals declaration",
      extra: `import legacy = require("./legacy");`,
    },
    {
      label: "exported import-equals declaration",
      extra: `export import legacy = require("./legacy");`,
    },
    {
      label: "export-equals assignment",
      extra: `export = agent;`,
    },
    {
      label: "module.exports assignment",
      extra: `module.exports = agent;`,
    },
    {
      label: "exports property assignment",
      extra: `exports.agent = agent;`,
    },
    {
      label: "Object.defineProperty exports mutation",
      extra: `Object.defineProperty(exports, "agent", { value: agent });`,
    },
    {
      label: "conditional module.exports assignment",
      extra: `declare const condition: boolean;
if (condition) module.exports = agent;`,
    },
    {
      label: "Object.assign exports mutation",
      extra: `Object.assign(exports, { agent });`,
    },
    {
      label: "Reflect.defineProperty exports mutation",
      extra: `Reflect.defineProperty(exports, "agent", { value: agent });`,
    },
    {
      label: "exports escape to an unknown helper",
      extra: `declare function decorateExports(value: unknown): void;
decorateExports(exports);`,
    },
    {
      label: "immediately-invoked CommonJS mutation",
      extra: `(() => { module.exports.second = agent; })();`,
    },
    {
      label: "class static CommonJS mutation",
      extra: `class ExportDecorator {
  static { exports.second = agent; }
}`,
    },
    {
      label: "named function CommonJS mutation invoked later",
      extra: `function decorateExportsLater() {
  module.exports.second = agent;
}
decorateExportsLater();`,
    },
    {
      label: "class constructor CommonJS mutation invoked later",
      extra: `class ExportDecorator {
  constructor() { exports.second = agent; }
}
new ExportDecorator();`,
    },
  ])(
    "fails closed without executing an unsupported $label beside a proven ESM agent",
    async ({ extra }) => {
      await write(
        root,
        "index.ts",
        `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "esm-agent" });
${extra}
throw new Error("source discovery must never execute project code");`,
      );

      await expect(
        new AgentSourceDiscovery().inspectCandidate(root),
      ).resolves.toMatchObject({ status: "incomplete" });
    },
  );

  it("honors an explicit export that shadows an export-star name", async () => {
    await write(
      root,
      "a.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "explicit", entry: "start", steps: {} });`,
    );
    await write(
      root,
      "b.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "shadowed", entry: "start", steps: {} });`,
    );
    await write(
      root,
      "index.ts",
      `export { agent } from "./a.js";
export * from "./b.js";`,
    );

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "agent", name: "explicit" });
  });

  it("fails closed when export-stars provide the same name from different modules", async () => {
    await write(
      root,
      "a.ts",
      `import { defineAgent } from "@sapiom/agent";
export const candidate = defineAgent({ name: "hidden" });`,
    );
    await write(root, "b.ts", `export const candidate = {};`);
    await write(
      root,
      "barrel.ts",
      `export * from "./a.js";
export * from "./b.js";`,
    );
    await write(root, "index.ts", `export * from "./barrel.js";`);

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "incomplete" });

    await write(root, "index.ts", `export { candidate } from "./barrel.js";`);
    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "incomplete" });
  });

  it("resolves disjoint export-stars", async () => {
    await write(root, "ordinary.ts", `export const helper = {};`);
    await write(
      root,
      "agent.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "disjoint" });`,
    );
    await write(
      root,
      "index.ts",
      `export * from "./ordinary.js";
export * from "./agent.js";`,
    );

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "agent", name: "disjoint" });
  });

  it("accepts a star diamond that resolves to the same ultimate agent", async () => {
    await write(
      root,
      "shared.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "diamond" });`,
    );
    await write(root, "a.ts", `export * from "./shared";`);
    await write(root, "b.ts", `export * from "./shared";`);
    await write(
      root,
      "index.ts",
      `export * from "./a";
export * from "./b";`,
    );

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "agent", name: "diamond" });
  });

  it("fails closed for a star diamond with distinct ultimate agents", async () => {
    for (const branch of ["a", "b"]) {
      await write(
        root,
        `${branch}-agent.ts`,
        `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "${branch}" });`,
      );
      await write(root, `${branch}.ts`, `export * from "./${branch}-agent";`);
    }
    await write(
      root,
      "index.ts",
      `export * from "./a";
export * from "./b";`,
    );

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "incomplete" });
  });

  it("resolves export-star cycles once and still finds the reachable agent", async () => {
    await write(root, "index.ts", `export * from "./a";`);
    await write(
      root,
      "a.ts",
      `export * from "./b";
import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "cycle", entry: "start", steps: {} });`,
    );
    await write(root, "b.ts", `export * from "./a";`);

    const result = await new AgentSourceDiscovery().inspectCandidate(root);

    expect(result).toMatchObject({
      status: "agent",
      name: "cycle",
      modules: 3,
    });
  });

  it.each([
    {
      label: "explicit re-export cycle",
      files: {
        "index.ts": `export { agent } from "./a";`,
        "a.ts": `export { agent } from "./b";`,
        "b.ts": `export { agent } from "./a";`,
      },
    },
    {
      label: "local alias cycle",
      files: {
        "index.ts": `const first = second;
const second = first;
export { first as agent };`,
      },
    },
  ])("fails closed for an $label", async ({ files }) => {
    for (const [file, source] of Object.entries(files)) {
      await write(root, file, source);
    }

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "incomplete" });
  });

  it.each([
    `const defineAgent = (value: unknown) => value;
export const agent = defineAgent({ name: "fake" });`,
    `import { defineAgent } from "not-sapiom";
export const agent = defineAgent({ name: "fake" });`,
    `// defineAgent({ name: "comment" })
export const text = "defineAgent({ name: 'string' })";`,
    `import type { defineAgent } from "@sapiom/agent";
export const value = { name: "type-only" };`,
  ])("does not accept token-shaped false positives", async (source) => {
    await write(root, "index.ts", source);

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({
      status: "not-agent",
    });
  });

  it.each([
    {
      label: "dynamic factory",
      source: `import { defineAgent } from "@sapiom/agent";
const factory = Math.random() ? defineAgent : (value: unknown) => value;
export const agent = factory({ name: "dynamic" });`,
    },
    {
      label: "unresolved export",
      source: `export { agent } from "./missing";`,
    },
    {
      label: "invalid syntax",
      source: `export const agent = (;`,
    },
    {
      label: "dynamic conditional export",
      source: `import { defineAgent } from "@sapiom/agent";
declare const condition: boolean;
export default condition ? defineAgent({ name: "dynamic" }) : {};`,
    },
    {
      label: "mutable factory alias",
      source: `import { defineAgent } from "@sapiom/agent";
let factory = defineAgent;
export default factory({ name: "mutable" });`,
    },
    {
      label: "external dynamic factory",
      source: `import { maybeFactory } from "another-package";
export default maybeFactory({ name: "unknown" });`,
    },
    {
      label: "external namespace dynamic factory",
      source: `import * as external from "another-package";
export default external.maybeFactory({ name: "unknown" });`,
    },
    {
      label: "external value re-export",
      source: `export { agent } from "another-package";`,
    },
  ])("fails closed for $label", async ({ source }) => {
    await write(root, "index.ts", source);

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({
      status: "incomplete",
    });
  });

  it("accepts ordinary function, class, enum, and namespace exports beside one agent", async () => {
    await write(
      root,
      "index.ts",
      `import { defineAgent } from "@sapiom/agent";
export function helper() {}
export class Helper {}
export enum Kind { One }
export namespace Values { export const one = 1; }
export const agent = defineAgent({ name: "mixed", entry: "start", steps: {} });`,
    );

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "agent", name: "mixed" });
  });

  it("does not let unrelated destructuring poison a proven agent export", async () => {
    await write(
      root,
      "index.ts",
      `import { defineAgent } from "@sapiom/agent";
declare const config: { env: string };
const { env } = config;
void env;
export const agent = defineAgent({ name: "destructured-context" });`,
    );

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({
      status: "agent",
      name: "destructured-context",
    });
  });

  it("does not let unrelated mutable state or overloads poison a proven agent", async () => {
    await write(
      root,
      "index.ts",
      `import { defineAgent } from "@sapiom/agent";
let counter = 0;
counter++;
function helper(value: string): string;
function helper(value: unknown) { return String(value); }
void helper(counter);
export const agent = defineAgent({ name: "independent" });`,
    );

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "agent", name: "independent" });
  });

  it("accepts a valid exported overload beside a proven agent", async () => {
    await write(
      root,
      "index.ts",
      `import { defineAgent } from "@sapiom/agent";
export function helper(value: string): string;
export function helper(value: number): string;
export function helper(value: string | number) { return String(value); }
export const agent = defineAgent({ name: "exported-overload" });`,
    );

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "agent", name: "exported-overload" });
  });

  it.each([
    `import { defineAgent } from "@sapiom/agent";
const defineAgent = (value: unknown) => value;
export const agent = defineAgent({ name: "duplicate" });`,
    `import { defineAgent } from "@sapiom/agent";
export let agent = defineAgent({ name: "mutable" });
agent = {};`,
    `import { defineAgent } from "@sapiom/agent";
declare const flag: boolean;
const factory = defineAgent;
if (flag) factory = (value: unknown) => value;
export default factory({ name: "conditional-write" });`,
    `import { defineAgent } from "@sapiom/agent";
({ defineAgent } = { defineAgent: (value: unknown) => value });
export default defineAgent({ name: "destructuring-write" });`,
    `import { defineAgent } from "@sapiom/agent";
declare const factories: unknown[];
for (defineAgent of factories) {}
export default defineAgent({ name: "loop-write" });`,
    `import { defineAgent } from "@sapiom/agent";
declare const factories: unknown[];
[...defineAgent] = factories;
export default defineAgent({ name: "array-rest-write" });`,
    `import { defineAgent } from "@sapiom/agent";
declare const factories: unknown[];
[defineAgent = (value: unknown) => value] = factories;
export default defineAgent({ name: "array-default-write" });`,
    `import { defineAgent } from "@sapiom/agent";
declare const values: { x?: unknown };
({ x: defineAgent = (value: unknown) => value } = values);
export default defineAgent({ name: "object-default-write" });`,
    `import * as sdk from "@sapiom/agent";
sdk.defineAgent = (value: unknown) => value;
export default sdk.defineAgent({ name: "namespace-property-write" });`,
    `import * as sdk from "@sapiom/agent";
sdk["defineAgent"] = (value: unknown) => value;
export default sdk.defineAgent({ name: "namespace-element-write" });`,
    `export const { agent } = getValues();`,
  ])(
    "fails closed for mutable or unresolved top-level bindings",
    async (source) => {
      await write(root, "index.ts", source);

      await expect(
        new AgentSourceDiscovery().inspectCandidate(root),
      ).resolves.toMatchObject({ status: "incomplete" });
    },
  );

  it("does not treat a function-local shadow write as a top-level mutation", async () => {
    await write(
      root,
      "index.ts",
      `import { defineAgent } from "@sapiom/agent";
const factory = defineAgent;
function unrelated() { let factory = 1; factory = 2; return factory; }
export default factory({ name: "outer-stable" });`,
    );

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "agent", name: "outer-stable" });
  });

  it.each([
    `import { defineAgent } from "@sapiom/agent";
const build = () => defineAgent({ name: "wrapped" });
export default build();`,
    `const helper = () => ({ ordinary: true });
export default helper();`,
    `import { defineAgent } from "@sapiom/agent";
const box = { make: defineAgent };
export default box.make({ name: "member-alias" });`,
    `import { defineAgent } from "@sapiom/agent";
const box = { make: () => defineAgent({ name: "member-wrapper" }) };
export default box.make();`,
    `class Factory { static make() { return {}; } }
export default Factory.make();`,
  ])("fails closed for an uninspected local callable", async (source) => {
    await write(root, "index.ts", source);

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "incomplete" });
  });

  it.each([
    `import { defineAgent } from "@sapiom/agent";
const agent = defineAgent({ name: "one" });
const ordinary = {};
export { agent as default };
export { ordinary as default };`,
    `import { defineAgent } from "@sapiom/agent";
const agent = defineAgent({ name: "one" });
const ordinary = {};
export { agent as candidate };
export { ordinary as candidate };`,
  ])("fails closed for duplicate explicit export names", async (source) => {
    await write(root, "index.ts", source);

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "incomplete" });
  });

  it("deduplicates one definition exported under multiple names", async () => {
    await write(
      root,
      "index.ts",
      `import { defineAgent } from "@sapiom/agent";
const agent = defineAgent({ name: "once", entry: "start", steps: {} });
export { agent, agent as default };`,
    );

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "agent", name: "once" });
  });

  it("does not execute top-level project code or side-effect imports", async () => {
    const sentinel = `__sapiom_source_discovery_${Date.now()}`;
    await write(root, "side-effect.ts", `throw new Error("imported");`);
    await write(
      root,
      "index.ts",
      `import "./side-effect.js";
import { defineAgent } from "@sapiom/agent";
(globalThis as Record<string, unknown>)[${JSON.stringify(sentinel)}] = true;
throw new Error("executed");
export const agent = defineAgent({ name: "syntax-only", entry: "start", steps: {} });`,
    );

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "agent", name: "syntax-only" });
    expect((globalThis as Record<string, unknown>)[sentinel]).toBeUndefined();
  });

  it("fails closed when the entry exports multiple distinct definitions", async () => {
    await write(
      root,
      "index.ts",
      `import { defineAgent } from "@sapiom/agent";
export const one = defineAgent({ name: "one", entry: "start", steps: {} });
export const two = defineAgent({ name: "two", entry: "start", steps: {} });`,
    );

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({
      status: "incomplete",
      reason: "ambiguous-export",
    });
  });

  it("does not follow a relative import that escapes the candidate root", async () => {
    await write(
      path.dirname(root),
      `${path.basename(root)}-outside.ts`,
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "outside", entry: "start", steps: {} });`,
    );
    await write(
      root,
      "index.ts",
      `export { agent } from "../${path.basename(root)}-outside";`,
    );

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({
      status: "incomplete",
    });
  });

  it.skipIf(process.platform === "win32")(
    "does not follow a symlinked TypeScript module",
    async () => {
      const outside = `${root}-outside.ts`;
      await fs.writeFile(
        outside,
        `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "outside", entry: "start", steps: {} });`,
      );
      await fs.symlink(outside, path.join(root, "agent.ts"));
      await write(root, "index.ts", `export { agent } from "./agent";`);

      await expect(
        new AgentSourceDiscovery().inspectCandidate(root),
      ).resolves.toMatchObject({
        status: "incomplete",
      });
      await fs.rm(outside, { force: true });
    },
  );

  it("treats a removed or non-file entrypoint as definitively absent", async () => {
    const discovery = new AgentSourceDiscovery();
    await write(
      root,
      "index.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "before" });`,
    );
    await expect(discovery.inspectCandidate(root)).resolves.toMatchObject({
      status: "agent",
    });

    await fs.rm(path.join(root, "index.ts"));
    await expect(discovery.inspectCandidate(root)).resolves.toMatchObject({
      status: "absent",
    });
    await fs.mkdir(path.join(root, "index.ts"));
    await expect(discovery.inspectCandidate(root)).resolves.toMatchObject({
      status: "absent",
    });
  });

  it.skipIf(process.platform === "win32")(
    "treats a symlinked entrypoint as definitively absent",
    async () => {
      const outside = `${root}-entry.ts`;
      await fs.writeFile(outside, `export const ordinary = true;`);
      await fs.symlink(outside, path.join(root, "index.ts"));

      await expect(
        new AgentSourceDiscovery().inspectCandidate(root),
      ).resolves.toMatchObject({ status: "absent" });
      await fs.rm(outside, { force: true });
    },
  );

  it("allows a nested candidate to resolve shared source within the selected workspace", async () => {
    const candidate = path.join(root, "apps", "payments");
    await write(
      root,
      "shared/agent.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "shared", entry: "start", steps: {} });`,
    );
    await write(
      candidate,
      "index.ts",
      `export { agent } from "../../shared/agent.js";`,
    );

    await expect(
      new AgentSourceDiscovery().inspectCandidate(
        candidate,
        new AgentSourceScanBudget(),
        root,
      ),
    ).resolves.toMatchObject({ status: "agent", name: "shared" });
  });

  it.each(["node_modules", "dist", ".sapiom"])(
    "rejects source reached through ignored directory %s",
    async (ignored) => {
      const candidate = path.join(root, "apps", "payments");
      await write(
        root,
        `${ignored}/agent.ts`,
        `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "ignored" });`,
      );
      await write(
        candidate,
        "index.ts",
        `export { agent } from "../../${ignored}/agent.js";`,
      );

      await expect(
        new AgentSourceDiscovery().inspectCandidate(
          candidate,
          new AgentSourceScanBudget(),
          root,
        ),
      ).resolves.toMatchObject({ status: "incomplete" });
    },
  );

  it("rejects a relative import into a nested repository", async () => {
    const candidate = path.join(root, "apps", "payments");
    await write(root, "nested/.git", "gitdir: elsewhere");
    await write(
      root,
      "nested/agent.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "foreign" });`,
    );
    await write(
      candidate,
      "index.ts",
      `export { agent } from "../../nested/agent.js";`,
    );

    await expect(
      new AgentSourceDiscovery().inspectCandidate(
        candidate,
        new AgentSourceScanBudget(),
        root,
      ),
    ).resolves.toMatchObject({ status: "incomplete" });
  });

  it("allows a repository when that repository itself is the selected workspace", async () => {
    await write(root, ".git", "gitdir: elsewhere");
    await write(
      root,
      "index.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "selected-repo" });`,
    );

    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "agent", name: "selected-repo" });
  });

  it("rejects markerless source at a nested repository root under the selected workspace", async () => {
    const candidate = path.join(root, "nested-repo");
    await write(candidate, ".git", "gitdir: elsewhere");
    await write(
      candidate,
      "agent.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "nested-selected" });`,
    );
    await write(candidate, "index.ts", `export * from "./agent.js";`);

    await expect(
      new AgentSourceDiscovery().inspectCandidate(
        candidate,
        new AgentSourceScanBudget(),
        root,
      ),
    ).resolves.toMatchObject({ status: "incomplete" });
  });

  it.skipIf(process.platform === "win32")(
    "rejects relative imports through an intermediate directory symlink",
    async () => {
      const candidate = path.join(root, "apps", "payments");
      const shared = path.join(root, "shared-real");
      await write(
        shared,
        "agent.ts",
        `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "symlinked" });`,
      );
      await fs.symlink(shared, path.join(root, "shared"));
      await write(
        candidate,
        "index.ts",
        `export { agent } from "../../shared/agent.js";`,
      );

      await expect(
        new AgentSourceDiscovery().inspectCandidate(
          candidate,
          new AgentSourceScanBudget(),
          root,
        ),
      ).resolves.toMatchObject({ status: "incomplete" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed when an admitted ancestor is swapped to a symlink",
    async () => {
      const candidate = path.join(root, "apps", "candidate");
      const moved = path.join(root, "apps", "candidate-real");
      await write(candidate, "index.ts", `export { agent } from "./agent.js";`);
      await write(
        candidate,
        "agent.ts",
        `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "must-not-follow" });`,
      );
      let swapped = false;
      const discovery = new AgentSourceDiscovery(new AgentSourceModuleCache(), {
        beforeModuleLookup: async (file) => {
          if (!file.endsWith(`${path.sep}agent.ts`) || swapped) return;
          swapped = true;
          await fs.rename(candidate, moved);
          await fs.symlink(moved, candidate, "dir");
        },
      });

      await expect(
        discovery.inspectCandidate(
          candidate,
          new AgentSourceScanBudget(),
          root,
        ),
      ).resolves.toMatchObject({ status: "incomplete" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not read or block on a FIFO reached through an ancestor swap",
    async () => {
      const candidate = path.join(root, "apps", "candidate");
      const moved = path.join(root, "apps", "candidate-real");
      const replacement = path.join(root, "apps", "replacement");
      await write(candidate, "index.ts", `export * from "./agent.js";`);
      await write(candidate, "agent.ts", `export const ordinary = true;`);
      await fs.mkdir(replacement, { recursive: true });
      await execFileAsync("mkfifo", [path.join(replacement, "agent.ts")]);
      const byteReads: string[] = [];
      let swapped = false;
      const discovery = new AgentSourceDiscovery(new AgentSourceModuleCache(), {
        beforeModuleRead: async (file) => {
          if (!file.endsWith(`${path.sep}agent.ts`) || swapped) return;
          swapped = true;
          await fs.rename(candidate, moved);
          await fs.symlink(replacement, candidate, "dir");
        },
        onModuleBytesRead: (file) => byteReads.push(file),
      });

      await expect(
        discovery.inspectCandidate(
          candidate,
          new AgentSourceScanBudget(),
          root,
        ),
      ).resolves.toMatchObject({ status: "incomplete" });
      expect(byteReads).not.toContain(path.join(candidate, "agent.ts"));
    },
  );

  it.skipIf(process.platform === "win32")(
    "resolves split source from a symlinked selected workspace root",
    async () => {
      const link = `${root}-link`;
      await write(
        root,
        "agent.ts",
        `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "symlink-root" });`,
      );
      await write(root, "index.ts", `export * from "./agent.js";`);
      await fs.symlink(root, link);

      await expect(
        new AgentSourceDiscovery().inspectCandidate(link),
      ).resolves.toMatchObject({ status: "agent", name: "symlink-root" });
      await fs.rm(link, { force: true });
    },
  );

  it("rejects a file that grows between stat and its bounded read", async () => {
    const entry = path.join(root, "index.ts");
    await write(root, "index.ts", `export const ordinary = true;`);
    let mutated = false;
    const discovery = new AgentSourceDiscovery(new AgentSourceModuleCache(), {
      beforeModuleRead: async (file) => {
        if (file !== entry || mutated) return;
        mutated = true;
        await fs.writeFile(file, Buffer.alloc(2 * 1024 * 1024, 32));
      },
    });

    await expect(discovery.inspectCandidate(root)).resolves.toMatchObject({
      status: "incomplete",
    });
  });

  it("rejects a stale cache hit when the module changes after its initial stat", async () => {
    const entry = path.join(root, "index.ts");
    await write(
      root,
      "index.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "cached" });`,
    );
    const cache = new AgentSourceModuleCache();
    await new AgentSourceDiscovery(cache).inspectCandidate(root);
    let mutated = false;
    const discovery = new AgentSourceDiscovery(cache, {
      beforeModuleRead: async (file) => {
        if (file !== entry || mutated) return;
        mutated = true;
        await fs.writeFile(file, `export const ordinary = false;`);
      },
    });

    await expect(discovery.inspectCandidate(root)).resolves.toMatchObject({
      status: "incomplete",
    });
  });

  it("rejects cold and warm modules when a nested repository appears before read", async () => {
    const candidate = path.join(root, "candidate");
    await write(
      candidate,
      "index.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "before-boundary" });`,
    );

    for (const warm of [false, true]) {
      await fs.rm(path.join(candidate, ".git"), {
        recursive: true,
        force: true,
      });
      const cache = new AgentSourceModuleCache();
      if (warm) {
        await expect(
          new AgentSourceDiscovery(cache).inspectCandidate(
            candidate,
            new AgentSourceScanBudget(),
            root,
          ),
        ).resolves.toMatchObject({ status: "agent" });
      }
      let inserted = false;
      const discovery = new AgentSourceDiscovery(cache, {
        beforeModuleRead: async (file) => {
          if (!file.endsWith(`${path.sep}index.ts`) || inserted) return;
          inserted = true;
          await fs.mkdir(path.join(candidate, ".git"));
        },
      });

      await expect(
        discovery.inspectCandidate(
          candidate,
          new AgentSourceScanBudget(),
          root,
        ),
      ).resolves.toMatchObject({ status: "incomplete" });
    }
  });

  it("accepts import depth 8 and fails closed at depth 9", async () => {
    const writeChain = async (depth: number, name: string) => {
      await write(root, "index.ts", `export * from "./m1";`);
      for (let index = 1; index <= depth; index += 1) {
        await write(
          root,
          `m${index}.ts`,
          index === depth
            ? `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "${name}" });`
            : `export * from "./m${index + 1}";`,
        );
      }
    };

    await writeChain(AGENT_SOURCE_MAX_IMPORT_DEPTH, "at-depth-limit");
    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "agent", name: "at-depth-limit" });

    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    await writeChain(AGENT_SOURCE_MAX_IMPORT_DEPTH + 1, "too-deep");
    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({ status: "incomplete" });
  });

  it("accepts exactly 32 candidate modules and rejects the 33rd", async () => {
    const writeWideGraph = async (modules: number) => {
      await write(
        root,
        "index.ts",
        Array.from(
          { length: modules - 1 },
          (_, index) => `export * from "./m${index}";`,
        ).join("\n"),
      );
      for (let index = 0; index < modules - 1; index += 1) {
        await write(
          root,
          `m${index}.ts`,
          index === 0
            ? `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "wide" });`
            : `export const helper${index} = ${index};`,
        );
      }
    };

    await writeWideGraph(AGENT_SOURCE_MAX_MODULES_PER_CANDIDATE);
    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({
      status: "agent",
      name: "wide",
      modules: AGENT_SOURCE_MAX_MODULES_PER_CANDIDATE,
    });

    await writeWideGraph(AGENT_SOURCE_MAX_MODULES_PER_CANDIDATE + 1);
    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({
      status: "incomplete",
      reason: "budget",
      modules: AGENT_SOURCE_MAX_MODULES_PER_CANDIDATE,
    });
  });

  it("accepts exactly 1 MiB per candidate and rejects one byte more", async () => {
    const source = `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "byte-limit" });`;
    await write(
      root,
      "index.ts",
      padSourceToBytes(source, AGENT_SOURCE_MAX_BYTES_PER_CANDIDATE),
    );
    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({
      status: "agent",
      name: "byte-limit",
      bytes: AGENT_SOURCE_MAX_BYTES_PER_CANDIDATE,
    });

    await write(
      root,
      "index.ts",
      padSourceToBytes(source, AGENT_SOURCE_MAX_BYTES_PER_CANDIDATE + 1),
    );
    await expect(
      new AgentSourceDiscovery().inspectCandidate(root),
    ).resolves.toMatchObject({
      status: "incomplete",
      reason: "budget",
      bytes: 0,
    });
  });

  it("pins the exact scan-wide module and byte envelopes", () => {
    const modules = new AgentSourceScanBudget();
    for (let index = 0; index < AGENT_SOURCE_MAX_MODULES_PER_SCAN; index += 1) {
      expect(modules.admit(`/module-${index}.ts`, 0)).toBe(true);
    }
    expect(modules.modules).toBe(AGENT_SOURCE_MAX_MODULES_PER_SCAN);
    expect(modules.admit("/module-over-limit.ts", 0)).toBe(false);
    expect(modules.truncated).toBe(true);

    const bytes = new AgentSourceScanBudget();
    expect(bytes.admit("/exact.ts", AGENT_SOURCE_MAX_BYTES_PER_SCAN)).toBe(
      true,
    );
    // Re-admitting a warm/shared canonical module is free logically.
    expect(bytes.admit("/exact.ts", AGENT_SOURCE_MAX_BYTES_PER_SCAN)).toBe(
      true,
    );
    expect(bytes.bytes).toBe(AGENT_SOURCE_MAX_BYTES_PER_SCAN);
    expect(bytes.admit("/one-byte-more.ts", 1)).toBe(false);
    expect(bytes.truncated).toBe(true);
  });

  it("enforces the 2,000/2,001 scan module boundary end to end", async () => {
    const candidates: string[] = [];
    const source = `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "large-repo" });`;
    for (
      let index = 0;
      index < AGENT_SOURCE_MAX_MODULES_PER_SCAN + 1;
      index += 1
    ) {
      const candidate = path.join(root, `candidate-${index}`);
      candidates.push(candidate);
      await write(candidate, "index.ts", source);
    }
    const discovery = new AgentSourceDiscovery();
    const inspect = async () => {
      const budget = new AgentSourceScanBudget();
      const statuses: string[] = [];
      for (const candidate of candidates) {
        statuses.push(
          (await discovery.inspectCandidate(candidate, budget, root)).status,
        );
      }
      return {
        statuses,
        modules: budget.modules,
        bytes: budget.bytes,
        truncated: budget.truncated,
      };
    };

    const cold = await inspect();
    const warm = await inspect();
    expect(cold.statuses.slice(0, AGENT_SOURCE_MAX_MODULES_PER_SCAN)).toEqual(
      Array.from({ length: AGENT_SOURCE_MAX_MODULES_PER_SCAN }, () => "agent"),
    );
    expect(cold.statuses.at(-1)).toBe("incomplete");
    expect(cold.modules).toBe(AGENT_SOURCE_MAX_MODULES_PER_SCAN);
    expect(cold.truncated).toBe(true);
    expect(warm).toEqual(cold);
  }, 20_000);

  it("enforces the exact 16 MiB/+1 scan byte boundary end to end", async () => {
    const exactCandidates: string[] = [];
    const source = `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "byte-scan" });`;
    const candidateCount =
      AGENT_SOURCE_MAX_BYTES_PER_SCAN / AGENT_SOURCE_MAX_BYTES_PER_CANDIDATE;
    for (let index = 0; index < candidateCount; index += 1) {
      const candidate = path.join(root, `byte-candidate-${index}`);
      exactCandidates.push(candidate);
      await write(
        candidate,
        "index.ts",
        padSourceToBytes(source, AGENT_SOURCE_MAX_BYTES_PER_CANDIDATE),
      );
    }
    const overCandidate = path.join(root, "byte-candidate-over");
    await write(overCandidate, "index.ts", "x");
    const discovery = new AgentSourceDiscovery();
    const inspect = async () => {
      const budget = new AgentSourceScanBudget();
      const exact = [];
      for (const candidate of exactCandidates) {
        exact.push(await discovery.inspectCandidate(candidate, budget, root));
      }
      const over = await discovery.inspectCandidate(
        overCandidate,
        budget,
        root,
      );
      return {
        exact: exact.map((result) => result.status),
        over: over.status,
        overReason: over.status === "incomplete" ? over.reason : null,
        bytes: budget.bytes,
        truncated: budget.truncated,
      };
    };

    const cold = await inspect();
    const warm = await inspect();
    expect(cold.exact).toEqual(
      Array.from({ length: candidateCount }, () => "agent"),
    );
    expect(cold).toMatchObject({
      over: "incomplete",
      overReason: "budget",
      bytes: AGENT_SOURCE_MAX_BYTES_PER_SCAN,
      truncated: true,
    });
    expect(warm).toEqual(cold);
  });

  it("bounds and memoizes missing-module lookup work", async () => {
    await write(
      root,
      "index.ts",
      Array.from(
        { length: 20 },
        (_, index) => `export { value as value${index} } from "./missing.js";`,
      ).join("\n"),
    );
    const repeated = await new AgentSourceDiscovery(
      new AgentSourceModuleCache(),
      { maxLookups: 5 },
    ).inspectCandidate(root);
    expect(repeated).toMatchObject({ status: "incomplete", lookups: 3 });

    await write(
      root,
      "index.ts",
      Array.from(
        { length: 20 },
        (_, index) =>
          `export { value as value${index} } from "./missing-${index}.js";`,
      ).join("\n"),
    );
    const budget = new AgentSourceScanBudget({ maxLookups: 7 });
    const unique = await new AgentSourceDiscovery(
      new AgentSourceModuleCache(),
      { maxLookups: 5 },
    ).inspectCandidate(root, budget);
    expect(unique).toMatchObject({
      status: "incomplete",
      reason: "budget",
      lookups: 5,
    });
    expect(budget.lookups).toBe(5);
  });

  it("deduplicates repeated stars and bounds dense export-resolution work", async () => {
    await write(
      root,
      "agent.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "repeated-star" });`,
    );
    await write(
      root,
      "index.ts",
      Array.from({ length: 2_000 }, () => `export * from "./agent";`).join(
        "\n",
      ),
    );
    let steps = 0;
    const discovery = new AgentSourceDiscovery(new AgentSourceModuleCache(), {
      onResolutionStep: () => {
        steps += 1;
      },
    });
    const inspect = async () => {
      steps = 0;
      const result = await discovery.inspectCandidate(root);
      return { result, steps };
    };
    const cold = await inspect();
    const warm = await inspect();
    expect(cold.result).toMatchObject({
      status: "agent",
      name: "repeated-star",
    });
    expect(warm).toEqual(cold);
    expect(cold.steps).toBeLessThan(20);

    const branches = Array.from(
      { length: 12 },
      (_, index) => `branch-${index}`,
    );
    for (const branch of branches) {
      await write(root, `${branch}.ts`, `export * from "./agent";`);
    }
    await write(
      root,
      "index.ts",
      branches.map((branch) => `export * from "./${branch}";`).join("\n"),
    );
    let boundedSteps = 0;
    await expect(
      new AgentSourceDiscovery(new AgentSourceModuleCache(), {
        maxResolutionSteps: 20,
        onResolutionStep: () => {
          boundedSteps += 1;
        },
      }).inspectCandidate(root),
    ).resolves.toMatchObject({ status: "incomplete", reason: "budget" });
    expect(boundedSteps).toBe(20);
  });

  it("charges and reads a canonical module only once scan-wide across candidates", async () => {
    await write(
      root,
      "shared/agent.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "shared" });`,
    );
    const candidates = Array.from({ length: 12 }, (_, index) =>
      path.join(root, "apps", `candidate-${index}`),
    );
    for (const candidate of candidates) {
      await write(
        candidate,
        "index.ts",
        `export { agent } from "../../shared/agent.js";`,
      );
    }
    const metadataLoads: string[] = [];
    const contentLoads: string[] = [];
    const discovery = new AgentSourceDiscovery(new AgentSourceModuleCache(), {
      beforeModuleLookup: (file) => {
        metadataLoads.push(file);
      },
      beforeModuleRead: async (file) => {
        contentLoads.push(file);
      },
    });
    const budget = new AgentSourceScanBudget();

    const results = [];
    for (const candidate of candidates) {
      results.push(await discovery.inspectCandidate(candidate, budget, root));
    }

    expect(results).toEqual(
      candidates.map(() =>
        expect.objectContaining({
          status: "agent",
          name: "shared",
          modules: 2,
        }),
      ),
    );
    expect(budget.modules).toBe(candidates.length + 1);
    expect(new Set(metadataLoads).size).toBe(candidates.length + 1);
    expect(metadataLoads).toHaveLength(candidates.length + 1);
    expect(new Set(contentLoads).size).toBe(candidates.length + 1);
    expect(contentLoads).toHaveLength(candidates.length + 1);
  });

  it("memoizes shared missing-resolution probes across candidate graphs", async () => {
    await fs.mkdir(path.join(root, "shared"), { recursive: true });
    const candidates = Array.from({ length: 20 }, (_, index) =>
      path.join(root, "apps", `candidate-${index}`),
    );
    for (const candidate of candidates) {
      await write(
        candidate,
        "index.ts",
        `export { agent } from "../../shared/missing";`,
      );
    }
    const metadataLoads: string[] = [];
    const discovery = new AgentSourceDiscovery(new AgentSourceModuleCache(), {
      beforeModuleLookup: (file) => {
        metadataLoads.push(file);
      },
    });
    const budget = new AgentSourceScanBudget();

    for (const candidate of candidates) {
      await expect(
        discovery.inspectCandidate(candidate, budget, root),
      ).resolves.toMatchObject({ status: "incomplete" });
    }

    // One entrypoint per candidate, four direct extensions, then the first
    // index candidate proves the shared missing directory cannot be entered.
    expect(metadataLoads).toHaveLength(candidates.length + 5);
    expect(new Set(metadataLoads).size).toBe(metadataLoads.length);
    expect(budget.lookups).toBe(metadataLoads.length);
  });

  it("charges cold, warm, and post-eviction scans identically", async () => {
    await write(root, "index.ts", `export { agent } from "./agent";`);
    await write(
      root,
      "agent.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "stable", entry: "start", steps: {} });`,
    );
    const cache = new AgentSourceModuleCache(2);
    const discovery = new AgentSourceDiscovery(cache);
    const inspect = async () => {
      const budget = new AgentSourceScanBudget({ maxModules: 2 });
      const result = await discovery.inspectCandidate(root, budget);
      return { result, modules: budget.modules, bytes: budget.bytes };
    };

    const cold = await inspect();
    const warm = await inspect();
    expect(warm).toEqual(cold);

    const other = await fs.mkdtemp(
      path.join(os.tmpdir(), "harness-source-cache-"),
    );
    await write(other, "index.ts", `export const ordinary = {};`);
    await discovery.inspectCandidate(other);
    await fs.rm(other, { recursive: true, force: true });

    expect(await inspect()).toEqual(cold);
  });

  it("enforces the 10,000-entry LRU ceiling with true recency", () => {
    const cache = new AgentSourceModuleCache();
    const parsed = {
      bindings: new Map(),
      exports: new Map(),
      exportStars: [],
      parseable: true,
      unresolved: false,
    };
    for (
      let index = 0;
      index < AGENT_SOURCE_MODULE_CACHE_MAX_ENTRIES;
      index += 1
    ) {
      cache.set(`/module-${index}.ts`, 1, index, 1, index + 1, parsed);
    }
    expect(cache.size).toBe(AGENT_SOURCE_MODULE_CACHE_MAX_ENTRIES);
    expect(cache.get("/module-0.ts", 1, 0, 1, 1)).toBe(parsed);

    cache.set(
      "/module-over-limit.ts",
      1,
      AGENT_SOURCE_MODULE_CACHE_MAX_ENTRIES,
      1,
      AGENT_SOURCE_MODULE_CACHE_MAX_ENTRIES + 1,
      parsed,
    );

    expect(cache.size).toBe(AGENT_SOURCE_MODULE_CACHE_MAX_ENTRIES);
    expect(cache.get("/module-1.ts", 1, 1, 1, 2)).toBeNull();
    expect(cache.get("/module-0.ts", 1, 0, 1, 1)).toBe(parsed);
  });

  it("invalidates a split re-export when only its dependency changes", async () => {
    await write(root, "index.ts", `export { agent } from "./agent";`);
    await write(
      root,
      "agent.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "before", entry: "start", steps: {} });`,
    );
    const discovery = new AgentSourceDiscovery();
    await expect(discovery.inspectCandidate(root)).resolves.toMatchObject({
      status: "agent",
      name: "before",
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await write(root, "agent.ts", `export const noAgent = true;`);

    await expect(discovery.inspectCandidate(root)).resolves.toMatchObject({
      status: "not-agent",
    });
  });

  it("fingerprints absent relative candidates so creating one changes the result", async () => {
    await write(root, "index.ts", `export { agent } from "./agent.js";`);
    const discovery = new AgentSourceDiscovery();
    const before = await discovery.inspectCandidate(root);
    expect(before).toMatchObject({ status: "incomplete" });

    await write(
      root,
      "agent.ts",
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "appeared" });`,
    );
    const after = await discovery.inspectCandidate(root);

    expect(after).toMatchObject({ status: "agent", name: "appeared" });
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("uses collision-free JSON framing for fingerprint entries", async () => {
    const delimited = path.join(root, "part|with|pipes");
    await write(delimited, "index.ts", `export const ordinary = true;`);

    const result = await new AgentSourceDiscovery().inspectCandidate(delimited);
    const entries = JSON.parse(result.fingerprint) as string[];

    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("part|with|pipes");
  });
});
