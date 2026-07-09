/**
 * Seeds the bundled example project — a directory the harness opens
 * beautifully on first run. Shared by two callers with different needs:
 *
 *   - `POST /api/sample-project` (the welcome panel's "Run the sample
 *     project" action) — seeds `~/.sapiom/harness/sample-project` lazily and
 *     idempotently: an already-seeded copy is reused as-is, including any
 *     edits the user's agent has made to it since.
 *   - `scripts/seed-example.mjs` (demo prep) — same seeding with
 *     `force: true`, which wipes and regenerates from scratch.
 *
 * Produces:
 *   <targetRoot>/order-triage/    — a real scaffolded agent project
 *                                   (sapiom.json, index.ts, git repo) so the
 *                                   workflows rail discovers it immediately.
 *                                   Dependency versions are resolved the same
 *                                   way `sapiom agents init` does (current
 *                                   npm latest, offline fallback) — never
 *                                   hardcoded here, so this can't ship dead
 *                                   pins that no longer exist on npm.
 *   <targetRoot>/.sapiom/canvas/index.html + _template.html
 *                                 — the canvas kit's own template shell
 *                                   wrapping this project's real step-graph
 *                                   markup: the canvas pane's opening shot,
 *                                   and a reference for the shape of markup
 *                                   an agent should produce for Visualize.
 *                                   Rendered via the exact same
 *                                   renderCanvasDocument() shell the real
 *                                   visualize macro's edits go through, so
 *                                   the seed and the kit can never drift.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

import { resolveVersions, scaffold, writeConfig, type ResolvedVersions } from "@sapiom/agent-core";

import { TEMPLATE_HTML, renderCanvasDocument } from "./canvas-template.js";

const nodeRequire = createRequire(import.meta.url);

export const SAMPLE_PROJECT_NAME = "order-triage";

/** Locate @sapiom/agent-core's bundled templates dir (no `__dirname` in ESM). */
function agentCoreTemplatesDir(): string {
  const entry = nodeRequire.resolve("@sapiom/agent-core");
  return path.resolve(path.dirname(entry), "..", "..", "templates");
}

function tryGit(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Fold the demo customizations (index.ts, sapiom.json) into the scaffold's initial commit. */
function commitCustomizations(projectDir: string): void {
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
    <svg class="canvas-graph-svg" viewBox="0 0 960 500" width="960" height="500" xmlns="http://www.w3.org/2000/svg">
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

export interface SeedExampleProjectOptions {
  /** Directory the example lands in — the project goes to
   *  `<targetRoot>/order-triage/`, the canvas to `<targetRoot>/.sapiom/canvas/`. */
  targetRoot: string;
  /** Wipe and regenerate even when a seeded copy already exists (demo prep).
   *  Defaults to false: an existing copy is reused untouched. */
  force?: boolean;
  /** Pre-resolved @sapiom/* versions — skips the npm lookup (tests). */
  versions?: ResolvedVersions;
  /** Overrides where the scaffold templates live (tests). */
  templatesDir?: string;
}

export interface SeedExampleProjectResult {
  /** == options.targetRoot, resolved — the directory to open a session in. */
  root: string;
  /** Absolute path of the scaffolded project (`<root>/order-triage`). */
  projectDir: string;
  /** False when an existing seeded copy was reused as-is. */
  created: boolean;
  /** Whether a git repo with an initial commit was created (false on reuse or when `git` is unavailable). */
  gitInitialized: boolean;
}

/**
 * Seeds (or reuses) the example project under `options.targetRoot`.
 * Reuse is keyed on the project's own sapiom.json — the file the workflow
 * scanner keys on too, so "reusable" here means exactly "the rail will
 * discover it". The canvas pair is backfilled even on reuse (cheap, and an
 * older/partial seed shouldn't leave the canvas pane empty), but a canvas
 * the user's agent has since regenerated is left alone.
 */
export async function seedExampleProject(options: SeedExampleProjectOptions): Promise<SeedExampleProjectResult> {
  const root = path.resolve(options.targetRoot);
  const projectDir = path.join(root, SAMPLE_PROJECT_NAME);
  const canvasDir = path.join(root, ".sapiom", "canvas");
  const canvasFile = path.join(canvasDir, "index.html");
  const canvasTemplateFile = path.join(canvasDir, "_template.html");

  const alreadySeeded = existsSync(path.join(projectDir, "sapiom.json"));

  const writeCanvasPair = async (overwrite: boolean): Promise<void> => {
    await fs.mkdir(canvasDir, { recursive: true });
    // A pristine _template.html alongside the prefilled index.html — the same
    // pairing SessionManager's ensureCanvasTemplate() maintains for every
    // session, so re-visualizing this seeded project has a clean clone source.
    if (overwrite || !existsSync(canvasTemplateFile)) {
      await fs.writeFile(canvasTemplateFile, TEMPLATE_HTML, "utf8");
    }
    if (overwrite || !existsSync(canvasFile)) {
      await fs.writeFile(canvasFile, renderCanvasDocument(ORDER_TRIAGE_CANVAS_BODY), "utf8");
    }
  };

  if (alreadySeeded && !options.force) {
    await writeCanvasPair(false);
    return { root, projectDir, created: false, gitInitialized: false };
  }

  // Wipe a stale copy before rescaffolding — scaffold() refuses a non-empty dir.
  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });

  // Resolve the @sapiom/* dependency versions to stamp into the scaffold the
  // same way `sapiom agents init` does: current npm latest, with a 5s
  // timeout and an offline fallback (see @sapiom/agent-core's scaffold.ts) —
  // never a versions object hardcoded here, which is exactly how the old
  // standalone seed script once shipped dead pins that no longer exist on npm.
  const versions = options.versions ?? (await resolveVersions());

  const result = await scaffold({
    targetDir: projectDir,
    projectName: SAMPLE_PROJECT_NAME,
    templatesDir: options.templatesDir ?? agentCoreTemplatesDir(),
    versions,
  });

  await fs.writeFile(path.join(projectDir, "index.ts"), ORDER_TRIAGE_INDEX_TS, "utf8");
  writeConfig(projectDir, { name: SAMPLE_PROJECT_NAME });
  commitCustomizations(projectDir);

  await writeCanvasPair(true);

  return { root, projectDir, created: true, gitInitialized: result.gitInitialized };
}
