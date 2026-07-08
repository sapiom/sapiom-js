#!/usr/bin/env node
/**
 * Demo prep: seeds a directory the harness opens beautifully on first run.
 *
 *   pnpm --filter @sapiom/harness seed-example [dir] [--install]
 *   (default dir: ./harness-example; --install runs `npm install` in the
 *   scaffolded project afterward, to pre-warm node_modules ahead of a demo)
 *
 * Produces:
 *   <dir>/order-triage/       — a real scaffolded agent project (sapiom.json,
 *                               index.ts, git repo) so the workflows rail
 *                               discovers it immediately. Dependency versions
 *                               are resolved the same way `sapiom agents init`
 *                               does (current npm latest, offline fallback) —
 *                               never hardcoded here, so this can't ship dead
 *                               pins that no longer exist on npm.
 *   <dir>/.sapiom/canvas/index.html
 *                             — the canvas kit's own template (see
 *                               ../src/core/canvas-template.ts), prefilled
 *                               with this project's step-graph data — the
 *                               canvas pane's opening shot. Rendered via the
 *                               exact same renderCanvasHtml() the real
 *                               visualize macro's edits go through, so the
 *                               seed and the kit can never drift from each
 *                               other the way this file's old hand-rolled
 *                               HTML drifted from the style contract.
 *
 * Idempotent: re-running wipes and regenerates both from scratch.
 *
 * Requires the harness package itself to already be built (`pnpm build` or
 * `build:server`) — this imports renderCanvasHtml from dist/, the same way
 * it already needs @sapiom/agent-core's dist built.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

import { resolveVersions, scaffold, writeConfig } from "@sapiom/agent-core";
import { renderCanvasHtml } from "../dist/core/canvas-template.js";

const nodeRequire = createRequire(import.meta.url);

const PROJECT_NAME = "order-triage";

/** Locate @sapiom/agent-core's bundled templates dir (no __dirname in ESM). */
function agentCoreTemplatesDir() {
  const entry = nodeRequire.resolve("@sapiom/agent-core");
  return path.resolve(path.dirname(entry), "..", "..", "templates");
}

function tryGit(cwd, args) {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Fold the demo customizations (index.ts, sapiom.json) into the scaffold's initial commit. */
function commitCustomizations(projectDir) {
  if (!existsSync(path.join(projectDir, ".git"))) return;
  tryGit(projectDir, ["add", "-A"]);
  tryGit(projectDir, ["commit", "-m", "Customize for order-triage demo"]) ||
    tryGit(projectDir, [
      "-c",
      "user.name=Sapiom",
      "-c",
      "user.email=noreply@sapiom.ai",
      "commit",
      "-m",
      "Customize for order-triage demo",
    ]);
}

const ORDER_TRIAGE_INDEX_TS = `import { defineAgent, defineStep, goto, terminate } from '@sapiom/agent';
import { z } from 'zod';

// A small support-ticket triage flow: intake logs the order, classify tags
// it, and route sends the easy cases down an auto-resolve path while billing
// disputes go to a human.

const OrderSchema = z.object({ category: z.string().optional() }).passthrough();
const ClassifyInput = z.object({ order: OrderSchema, receivedAt: z.string() });
const RouteInput = z.object({ order: OrderSchema, receivedAt: z.string(), category: z.string() });

const intake = defineStep({
  name: 'intake',
  next: ['classify'],
  async run(input, ctx) {
    ctx.logger.info('order received', { input });
    return goto('classify', { order: input, receivedAt: new Date().toISOString() });
  },
});

const classify = defineStep({
  name: 'classify',
  next: ['route'],
  inputSchema: ClassifyInput,
  async run(input, ctx) {
    const category = input.order.category ?? 'general';
    ctx.logger.info('classified order', { category });
    return goto('route', { ...input, category });
  },
});

const route = defineStep({
  name: 'route',
  next: ['auto_resolve', 'escalate'],
  inputSchema: RouteInput,
  async run(input) {
    const needsHuman = input.category === 'billing_dispute';
    return goto(needsHuman ? 'escalate' : 'auto_resolve', input);
  },
});

const auto_resolve = defineStep({
  name: 'auto_resolve',
  next: [],
  terminal: true,
  inputSchema: RouteInput,
  async run(input) {
    return terminate({ resolved: true, category: input.category });
  },
});

const escalate = defineStep({
  name: 'escalate',
  next: [],
  terminal: true,
  inputSchema: RouteInput,
  async run(input, ctx) {
    ctx.logger.info('escalating to human', { category: input.category });
    return terminate({ resolved: false, escalated: true });
  },
});

export const agent = defineAgent({
  name: 'order-triage',
  entry: 'intake',
  steps: { intake, classify, route, auto_resolve, escalate },
});
`;

/**
 * Prefilled canvas-kit data for order-triage — mirrors index.ts's real
 * step graph exactly (5 steps, 1 branch, 2 terminal outcomes). Rendered
 * through the same `renderCanvasHtml()` the real visualize macro's edits
 * go through (see the module doc comment above).
 */
const ORDER_TRIAGE_CANVAS_DATA = {
  version: 1,
  graphs: [
    {
      id: "order-triage",
      title: "order-triage",
      subtitle: "Support-ticket triage: intake -> classify -> route, then auto-resolve or escalate to a human.",
      badges: ["standalone workflow", "not deployed yet"],
      stats: [
        { label: "steps", value: 5 },
        { label: "terminal outcomes", value: 2 },
        { label: "branch points", value: 1 },
      ],
      nodes: [
        { id: "intake", kind: "entry", label: "intake", sublabel: "receive + log order" },
        { id: "classify", kind: "step", label: "classify", sublabel: "tag order category" },
        { id: "route", kind: "step", label: "route", sublabel: "branch on category" },
        { id: "auto_resolve", kind: "terminal-success", label: "auto_resolve", sublabel: "terminate({resolved:true})" },
        { id: "escalate", kind: "terminal-warn", label: "escalate", sublabel: "terminate({escalated:true})" },
      ],
      edges: [
        { from: "intake", to: "classify", kind: "sequential" },
        { from: "classify", to: "route", kind: "sequential" },
        { from: "route", to: "auto_resolve", kind: "branching", label: "category != billing_dispute" },
        { from: "route", to: "escalate", kind: "branching", label: "billing_dispute" },
      ],
    },
  ],
  interconnections: [
    { from: "external", to: "order-triage.intake", kind: "signal", label: "an order object enters here" },
    { from: "order-triage.escalate", to: "external", kind: "handoff", label: "routes to a human out-of-band, not to another workflow" },
  ],
  note: "Static preview — ask your agent to regenerate the data after you change the workflow.",
};

function parseArgs(argv) {
  let dir;
  let install = false;
  for (const arg of argv) {
    if (arg === "--install") install = true;
    else if (!arg.startsWith("--")) dir = arg;
  }
  return { dir: dir ?? "./harness-example", install };
}

/** Best-effort `npm install` in the scaffolded project — used by --install to pre-warm node_modules for demo prep. */
function npmInstall(projectDir) {
  console.log(`Running npm install in ${projectDir} …`);
  const result = spawnSync("npm", ["install"], { cwd: projectDir, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`npm install failed (exit ${result.status}) in ${projectDir}`);
  }
}

async function main() {
  const { dir, install } = parseArgs(process.argv.slice(2));
  const targetRoot = path.resolve(dir);
  const projectDir = path.join(targetRoot, PROJECT_NAME);
  const canvasDir = path.join(targetRoot, ".sapiom", "canvas");
  const canvasFile = path.join(canvasDir, "index.html");

  // Idempotent: wipe a stale copy before rescaffolding.
  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.mkdir(targetRoot, { recursive: true });

  // Resolve the @sapiom/* dependency versions to stamp into the scaffold the
  // same way `sapiom agents init` does: current npm latest, with a 5s
  // timeout and an offline fallback (see @sapiom/agent-core's scaffold.ts) —
  // never a versions object hardcoded here, which is exactly how this
  // script previously shipped dead pins that no longer exist on npm.
  const versions = await resolveVersions();

  const result = await scaffold({
    targetDir: projectDir,
    projectName: PROJECT_NAME,
    templatesDir: agentCoreTemplatesDir(),
    versions,
  });

  await fs.writeFile(path.join(projectDir, "index.ts"), ORDER_TRIAGE_INDEX_TS, "utf8");
  writeConfig(projectDir, { name: PROJECT_NAME });
  commitCustomizations(projectDir);

  await fs.mkdir(canvasDir, { recursive: true });
  await fs.writeFile(canvasFile, renderCanvasHtml(ORDER_TRIAGE_CANVAS_DATA), "utf8");

  if (install) npmInstall(projectDir);

  const relToRoot = (p) => path.relative(targetRoot, p);
  const cwdRelative = path.relative(process.cwd(), targetRoot);
  const displayRoot = cwdRelative && !cwdRelative.startsWith("..") ? cwdRelative : targetRoot;

  console.log(`\nSeeded demo directory: ${targetRoot}\n`);
  console.log(
    `  ${relToRoot(projectDir)}/` +
      `  (sapiom.json + ${PROJECT_NAME} agent @ @sapiom/agent@${versions.agent} + @sapiom/tools@${versions.tools}, git ${
        result.gitInitialized ? "initialized" : "NOT initialized — git unavailable"
      }${install ? ", dependencies installed" : ""})`,
  );
  console.log(`  ${relToRoot(canvasFile)}  (opening canvas visualization)`);
  console.log("");
  console.log(`Next: cd ${displayRoot} && sapiom-harness`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
