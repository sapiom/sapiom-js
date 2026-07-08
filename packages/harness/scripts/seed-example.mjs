#!/usr/bin/env node
/**
 * Demo prep: seeds a directory the harness opens beautifully on first run.
 *
 *   pnpm --filter @sapiom/harness seed-example [dir]   (default ./harness-example)
 *
 * Produces:
 *   <dir>/order-triage/       — a real scaffolded agent project (sapiom.json,
 *                               index.ts, git repo) so the workflows rail
 *                               discovers it immediately.
 *   <dir>/.sapiom/canvas/index.html
 *                             — a static, self-contained visualization of
 *                               that project's step graph — the canvas pane's
 *                               opening shot, and a reference for the shape
 *                               of HTML an agent should produce for Visualize.
 *
 * Idempotent: re-running wipes and regenerates both from scratch.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

import { scaffold, writeConfig } from "@sapiom/agent-core";

const nodeRequire = createRequire(import.meta.url);

const PROJECT_NAME = "order-triage";

/**
 * Pinned offline fallback versions (mirrors @sapiom/agent-core's own
 * fallback constants) — demo prep should never depend on network
 * reachability. Bump alongside notable @sapiom/agent / @sapiom/tools releases.
 */
const SCAFFOLD_VERSIONS = { agent: "0.1.1", tools: "0.1.1", zod: "4.1.12" };

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

// A small support-ticket triage flow: intake logs the order, classify tags
// it, and route sends the easy cases down an auto-resolve path while billing
// disputes go to a human.

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
  async run(input, ctx) {
    const category = input.order?.category ?? 'general';
    ctx.logger.info('classified order', { category });
    return goto('route', { ...input, category });
  },
});

const route = defineStep({
  name: 'route',
  next: ['auto_resolve', 'escalate'],
  async run(input) {
    const needsHuman = input.category === 'billing_dispute';
    return goto(needsHuman ? 'escalate' : 'auto_resolve', input);
  },
});

const auto_resolve = defineStep({
  name: 'auto_resolve',
  next: [],
  terminal: true,
  async run(input) {
    return terminate({ resolved: true, category: input.category });
  },
});

const escalate = defineStep({
  name: 'escalate',
  next: [],
  terminal: true,
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

const CANVAS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>order-triage — Sapiom workflow canvas</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0e14;
    --panel: #12161f;
    --border: #1f2733;
    --text: #dbe4f0;
    --muted: #7c8a9e;
    --accent: #5b8cff;
    --success: #34d399;
    --warn: #f5a524;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    background: var(--bg);
    background-image:
      radial-gradient(circle at 15% 10%, rgba(91, 140, 255, 0.10), transparent 45%),
      radial-gradient(circle at 85% 90%, rgba(52, 211, 153, 0.08), transparent 45%);
    color: var(--text);
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  .canvas {
    max-width: 1040px;
    margin: 0 auto;
    padding: 28px 24px 20px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    min-height: 100%;
  }
  header { display: flex; flex-direction: column; gap: 10px; }
  .title-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
  .badge {
    font-size: 11px;
    padding: 3px 9px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--muted);
    background: rgba(255, 255, 255, 0.02);
  }
  .subtitle { margin: 0; color: var(--muted); font-size: 12.5px; }
  .subtitle code { color: #9db4d1; }
  .stats { display: flex; gap: 22px; margin-top: 2px; }
  .stat { display: flex; flex-direction: column; }
  .stat-value { font-size: 18px; font-weight: 600; color: var(--text); }
  .stat-label { font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }

  .diagram-panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 8px;
    flex: 1;
  }
  svg { display: block; width: 100%; height: auto; }

  .node rect {
    fill: #161c28;
    stroke: var(--accent);
    stroke-width: 1.4;
    filter: url(#node-glow);
  }
  .node-terminal.node-success rect { stroke: var(--success); }
  .node-terminal.node-warn rect { stroke: var(--warn); }
  .node-title {
    fill: var(--text);
    font-size: 15px;
    font-weight: 600;
    text-anchor: middle;
    dominant-baseline: middle;
  }
  .node-sub {
    fill: var(--muted);
    font-size: 10.5px;
    text-anchor: middle;
    dominant-baseline: middle;
  }
  .edge {
    fill: none;
    stroke: #2b3648;
    stroke-width: 2;
  }
  /* Flowing-dash overlay: a standard CSS/SVG technique (no SMIL) to suggest
     motion along each edge without relying on browser-inconsistent
     <animateMotion>. */
  .edge-flow {
    fill: none;
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-dasharray: 2 14;
    animation: flow 1.1s linear infinite;
  }
  .edge-flow-a { stroke: var(--accent); opacity: 0.85; }
  .edge-flow-b { stroke: var(--warn); opacity: 0.85; animation-delay: -0.55s; }
  @keyframes flow {
    to { stroke-dashoffset: -16; }
  }

  footer.legend {
    display: flex;
    align-items: center;
    gap: 18px;
    flex-wrap: wrap;
    padding: 4px 2px 2px;
    font-size: 11.5px;
    color: var(--muted);
  }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; border: 1.4px solid currentColor; background: transparent; }
  .dot-step { color: var(--accent); }
  .dot-success { color: var(--success); }
  .dot-warn { color: var(--warn); }
  .legend-note { margin-left: auto; color: #4b5768; font-style: italic; }
</style>
</head>
<body>
  <div class="canvas">
    <header>
      <div class="title-row">
        <h1>order-triage</h1>
        <span class="badge">not deployed yet</span>
      </div>
      <p class="subtitle">Sapiom workflow canvas · generated by <code>@sapiom/harness seed-example</code></p>
      <div class="stats">
        <div class="stat"><span class="stat-value">5</span><span class="stat-label">steps</span></div>
        <div class="stat"><span class="stat-value">2</span><span class="stat-label">terminal outcomes</span></div>
        <div class="stat"><span class="stat-value">1</span><span class="stat-label">branch</span></div>
      </div>
    </header>

    <div class="diagram-panel">
      <svg viewBox="0 0 960 560" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#2b3648" />
          </marker>
          <filter id="node-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#5b8cff" flood-opacity="0.18" />
          </filter>
        </defs>

        <!-- edges -->
        <path class="edge" d="M480,100 L480,150" marker-end="url(#arrow)" />
        <path class="edge" d="M480,210 L480,260" marker-end="url(#arrow)" />
        <path class="edge" d="M480,320 C480,365 250,365 250,410" marker-end="url(#arrow)" />
        <path class="edge" d="M480,320 C480,365 710,365 710,410" marker-end="url(#arrow)" />

        <!-- flowing-dash overlay: pure CSS animation, no script and no SMIL needed -->
        <path class="edge-flow edge-flow-a"
          d="M480,100 L480,150 L480,210 L480,260 L480,320 C480,365 250,365 250,410" />
        <path class="edge-flow edge-flow-b"
          d="M480,100 L480,150 L480,210 L480,260 L480,320 C480,365 710,365 710,410" />

        <!-- nodes -->
        <g class="node" transform="translate(380,40)">
          <rect width="200" height="60" rx="14" />
          <text x="100" y="26" class="node-title">intake</text>
          <text x="100" y="44" class="node-sub">receive + log order</text>
        </g>
        <g class="node" transform="translate(380,150)">
          <rect width="200" height="60" rx="14" />
          <text x="100" y="26" class="node-title">classify</text>
          <text x="100" y="44" class="node-sub">tag order category</text>
        </g>
        <g class="node" transform="translate(380,260)">
          <rect width="200" height="60" rx="14" />
          <text x="100" y="26" class="node-title">route</text>
          <text x="100" y="44" class="node-sub">branch on category</text>
        </g>
        <g class="node node-terminal node-success" transform="translate(140,410)">
          <rect width="220" height="70" rx="16" />
          <text x="110" y="30" class="node-title">auto_resolve</text>
          <text x="110" y="50" class="node-sub">terminate({ resolved: true })</text>
        </g>
        <g class="node node-terminal node-warn" transform="translate(600,410)">
          <rect width="220" height="70" rx="16" />
          <text x="110" y="30" class="node-title">escalate</text>
          <text x="110" y="50" class="node-sub">terminate({ escalated: true })</text>
        </g>
      </svg>
    </div>

    <footer class="legend">
      <span class="legend-item"><i class="dot dot-step"></i> step</span>
      <span class="legend-item"><i class="dot dot-success"></i> terminal · resolved</span>
      <span class="legend-item"><i class="dot dot-warn"></i> terminal · escalated</span>
      <span class="legend-note">Static preview — ask your agent to regenerate this after you change the workflow.</span>
    </footer>
  </div>
</body>
</html>
`;

async function main() {
  const targetRoot = path.resolve(process.argv[2] ?? "./harness-example");
  const projectDir = path.join(targetRoot, PROJECT_NAME);
  const canvasDir = path.join(targetRoot, ".sapiom", "canvas");
  const canvasFile = path.join(canvasDir, "index.html");

  // Idempotent: wipe a stale copy before rescaffolding.
  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.mkdir(targetRoot, { recursive: true });

  const result = await scaffold({
    targetDir: projectDir,
    projectName: PROJECT_NAME,
    templatesDir: agentCoreTemplatesDir(),
    versions: SCAFFOLD_VERSIONS,
  });

  await fs.writeFile(path.join(projectDir, "index.ts"), ORDER_TRIAGE_INDEX_TS, "utf8");
  writeConfig(projectDir, { name: PROJECT_NAME });
  commitCustomizations(projectDir);

  await fs.mkdir(canvasDir, { recursive: true });
  await fs.writeFile(canvasFile, CANVAS_HTML, "utf8");

  const relToRoot = (p) => path.relative(targetRoot, p);
  const cwdRelative = path.relative(process.cwd(), targetRoot);
  const displayRoot = cwdRelative && !cwdRelative.startsWith("..") ? cwdRelative : targetRoot;

  console.log(`Seeded demo directory: ${targetRoot}\n`);
  console.log(
    `  ${relToRoot(projectDir)}/` +
      `  (sapiom.json + ${PROJECT_NAME} agent, git ${
        result.gitInitialized ? "initialized" : "NOT initialized — git unavailable"
      })`,
  );
  console.log(`  ${relToRoot(canvasFile)}  (opening canvas visualization)`);
  console.log("");
  console.log(`Next: cd ${displayRoot} && sapiom-harness`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
