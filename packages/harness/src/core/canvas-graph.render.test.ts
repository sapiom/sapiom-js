/**
 * The Canvas render path, end to end, on a project that is fine: readable,
 * dependencies installed, entry present. This is the case the reporter of the
 * `Cannot read directory "../../../../../../../.."` failure was in — his `check`
 * passed on that same directory while the Canvas didn't — so the assertion that
 * matters is "the graph extracts", not "the error message reads better".
 *
 * What makes it a regression test rather than a smoke test is *where it runs
 * from*: extraction spawns its child with cwd set to the harness package root,
 * never the project, so esbuild's working directory is ours unless `check()`
 * anchors it (`absWorkingDir`). Vitest's cwd is that same package root, so this
 * reproduces the invocation faithfully — a project directory that shares no
 * ancestor with the caller beyond the filesystem root.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractWorkflowGraph } from "./canvas-graph.js";

/** This package's `node_modules`, borrowed so the fixture has real deps. */
const harnessModules = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "node_modules",
);

const AGENT_SOURCE = `import { defineAgent, defineStep, terminate } from "@sapiom/agent";
import { z } from "zod/v4";

const greet = defineStep({
  name: "greet",
  inputSchema: z.object({ name: z.string().default("world") }),
  next: [],
  terminal: true,
  async run(input: { name?: string }) {
    return terminate({ greeting: \`Hello, \${input?.name ?? "world"}!\` });
  },
});

export const agent = defineAgent({
  name: "canvas-render-fixture",
  entry: "greet",
  steps: { greet },
});
`;

describe("extractWorkflowGraph on an installed project", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "canvas-render-"));
    writeFileSync(path.join(dir, "index.ts"), AGENT_SOURCE);
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "canvas-render-fixture", type: "module" }),
    );
    symlinkSync(harnessModules, path.join(dir, "node_modules"), "dir");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("extracts the graph when invoked from the harness package root", async () => {
    const result = await extractWorkflowGraph(dir);

    // Fail loudly with the reason: a bundle failure here is the reported bug.
    expect(result.ok ? null : result.reason).toBeNull();
    if (!result.ok) return;
    expect(result.graph.manifestName).toBe("canvas-render-fixture");
    expect(result.graph.entry).toBe("greet");
    expect(result.graph.nodes.map((n) => n.id)).toEqual(["greet"]);
  });
});
