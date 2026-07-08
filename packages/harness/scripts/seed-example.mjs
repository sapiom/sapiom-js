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
 *   <dir>/.sapiom/canvas/index.html + _template.html
 *                             — the canvas kit's own template shell (see
 *                               ../src/core/canvas-template.ts) wrapping
 *                               this project's real step-graph markup — the
 *                               canvas pane's opening shot, and a reference
 *                               for the shape of markup an agent should
 *                               produce for Visualize. Rendered via the
 *                               exact same renderCanvasDocument() shell the
 *                               real visualize macro's edits go through, so
 *                               the seed and the kit can never drift from
 *                               each other the way this file's old
 *                               hand-rolled HTML drifted from the style
 *                               contract.
 *
 * Idempotent: re-running wipes and regenerates both from scratch.
 *
 * Requires the harness package itself to already be built (`pnpm build` or
 * `build:server`) — this imports renderCanvasDocument from dist/, the same
 * way it already needs @sapiom/agent-core's dist built.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

import { resolveVersions, scaffold, writeConfig } from "@sapiom/agent-core";
import { TEMPLATE_HTML, renderCanvasDocument } from "../dist/core/canvas-template.js";

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
 * Prefilled canvas-kit BODY for order-triage — hand-authored markup using
 * the template's own classes/patterns (core/canvas-template.ts), exactly as
 * an agent following the visualize macro's prompt would produce. Mirrors
 * index.ts's real step graph (5 steps, 1 branch, 2 terminal outcomes).
 * Wrapped through the same `renderCanvasDocument()` shell the real
 * visualize macro's edits go through (see the module doc comment above).
 */
const ORDER_TRIAGE_CANVAS_BODY = `
<section class="canvas-panel">
  <header class="canvas-header">
    <div class="canvas-title-row">
      <h1 class="canvas-title">order-triage</h1>
      <span class="canvas-badge">standalone workflow</span>
      <span class="canvas-badge">not deployed yet</span>
    </div>
    <p class="canvas-subtitle">Support-ticket triage: intake -&gt; classify -&gt; route, then auto-resolve or escalate to a human.</p>
    <div class="canvas-stats">
      <div class="canvas-stat"><span class="canvas-stat-value">5</span><span class="canvas-stat-label">steps</span></div>
      <div class="canvas-stat"><span class="canvas-stat-value">2</span><span class="canvas-stat-label">terminal outcomes</span></div>
      <div class="canvas-stat"><span class="canvas-stat-value">1</span><span class="canvas-stat-label">branch points</span></div>
    </div>
  </header>
  <div class="canvas-diagram-panel">
    <svg class="canvas-graph-svg" viewBox="0 0 960 500" xmlns="http://www.w3.org/2000/svg">
      <path class="canvas-edge" d="M480,96 L480,150" marker-end="url(#canvas-arrow)" />
      <path class="canvas-edge" d="M480,206 L480,260" marker-end="url(#canvas-arrow)" />
      <path class="canvas-edge canvas-edge--success" d="M480,316 C480,360 288,360 288,410" marker-end="url(#canvas-arrow-success)" />
      <path class="canvas-edge canvas-edge--warn" d="M480,316 C480,360 688,360 688,410" marker-end="url(#canvas-arrow-warn)" />
      <text class="canvas-edge-label" x="440" y="345" text-anchor="end">category != billing_dispute</text>
      <text class="canvas-edge-label" x="520" y="345" text-anchor="start">billing_dispute</text>

      <g class="canvas-node node--entry" filter="url(#canvas-glow)" transform="translate(392,40)">
        <rect class="canvas-node-rect" width="176" height="56" rx="14" />
        <text class="canvas-node-title" x="88" y="24">intake</text>
        <text class="canvas-node-sub" x="88" y="40">receive + log order</text>
      </g>
      <g class="canvas-node node--step" filter="url(#canvas-glow)" transform="translate(392,150)">
        <rect class="canvas-node-rect" width="176" height="56" rx="14" />
        <text class="canvas-node-title" x="88" y="24">classify</text>
        <text class="canvas-node-sub" x="88" y="40">tag order category</text>
      </g>
      <g class="canvas-node node--step" filter="url(#canvas-glow)" transform="translate(392,260)">
        <rect class="canvas-node-rect" width="176" height="56" rx="14" />
        <text class="canvas-node-title" x="88" y="24">route</text>
        <text class="canvas-node-sub" x="88" y="40">branch on category</text>
      </g>
      <g class="canvas-node node--terminal-success" filter="url(#canvas-glow)" transform="translate(200,410)">
        <rect class="canvas-node-rect" width="176" height="56" rx="14" />
        <text class="canvas-node-title" x="88" y="24">auto_resolve</text>
        <text class="canvas-node-sub" x="88" y="40">terminate({resolved:true})</text>
      </g>
      <g class="canvas-node node--terminal-warn" filter="url(#canvas-glow)" transform="translate(600,410)">
        <rect class="canvas-node-rect" width="176" height="56" rx="14" />
        <text class="canvas-node-title" x="88" y="24">escalate</text>
        <text class="canvas-node-sub" x="88" y="40">terminate({escalated:true})</text>
      </g>
    </svg>
  </div>
</section>

<section class="canvas-panel canvas-interconnections">
  <h2 class="canvas-panel-title">Interconnections</h2>
  <div class="canvas-interconnection-row">
    <span class="canvas-legend-marker canvas-legend-marker--entry"></span>
    <span class="canvas-interconnection-title">external -&gt; intake</span>
    <span class="canvas-interconnection-tag">signal</span>
    <p class="canvas-interconnection-desc">an order object enters here</p>
  </div>
  <div class="canvas-interconnection-row">
    <span class="canvas-legend-marker canvas-legend-marker--terminal-warn"></span>
    <span class="canvas-interconnection-title">escalate -&gt; external</span>
    <span class="canvas-interconnection-tag">handoff</span>
    <p class="canvas-interconnection-desc">routes to a human out-of-band, not to another workflow</p>
  </div>
</section>

<footer class="canvas-footer">
  <div class="canvas-legend">
    <span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--entry"></span>entry / active step</span>
    <span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--step"></span>step</span>
    <span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--terminal-success"></span>terminal &middot; success</span>
    <span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--terminal-warn"></span>terminal &middot; escalation</span>
    <span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--cross"></span>cross-workflow signal/handoff</span>
  </div>
  <p class="canvas-note">Static preview — ask your agent to regenerate this after you change the workflow.</p>
</footer>
`.trim();

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
  const canvasTemplateFile = path.join(canvasDir, "_template.html");

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
  // A pristine _template.html alongside the prefilled index.html — the same
  // pairing SessionManager's ensureCanvasTemplate() maintains for every
  // session, so re-visualizing this seeded project has a clean clone source.
  await fs.writeFile(canvasTemplateFile, TEMPLATE_HTML, "utf8");
  await fs.writeFile(canvasFile, renderCanvasDocument(ORDER_TRIAGE_CANVAS_BODY), "utf8");

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
