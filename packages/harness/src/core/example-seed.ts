/**
 * Seeds the bundled example project — a directory the harness opens
 * beautifully on first run.
 *
 * ONE caller today: `scripts/seed-example.mjs` (demo prep), which seeds with
 * `force: true` — wipe and regenerate from scratch.
 *
 * There was a second: `POST /api/sample-project`, behind the welcome panel's
 * "Sample project" action, which seeded `~/.sapiom/harness/sample-project`
 * lazily and idempotently. Both the route and the action were removed because
 * the in-app flow did not work; this module was kept because the demo script
 * still needs it. So an existing `~/.sapiom/harness/sample-project/` on a
 * machine is leftover output, not state the app maintains — nothing in the
 * running Studio reads or writes it.
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
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  installProjectDependencies,
  resolveVersions,
  scaffold,
  writeConfig,
  type ResolvedVersions,
} from "@sapiom/agent-core";

import { agentCoreTemplatesDir } from "./agent-core-templates.js";

export const SAMPLE_PROJECT_NAME = "order-triage";

function tryGit(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
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

export interface SeedExampleProjectOptions {
  /** Directory the example lands in — the project goes to
   *  `<targetRoot>/order-triage/`. */
  targetRoot: string;
  /** Wipe and regenerate even when a seeded copy already exists (demo prep).
   *  Defaults to false: an existing copy is reused untouched. */
  force?: boolean;
  /** Pre-resolved @sapiom/* versions — skips the npm lookup (tests). */
  versions?: ResolvedVersions;
  /** Overrides where the scaffold templates live (tests). */
  templatesDir?: string;
  /** Run `npm install` in the freshly-scaffolded project so the Canvas can
   *  bundle it on first render. Defaults to true; set false in tests to keep
   *  them offline/fast. Ignored on reuse (nothing is re-scaffolded). */
  installDependencies?: boolean;
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
  /** Whether `npm install` succeeded for the freshly-scaffolded project (false
   *  on reuse, or when npm is missing/offline — the Canvas then degrades to its
   *  "ask your agent to fix it" prompt on first render). */
  dependenciesInstalled: boolean;
}

/**
 * Seeds (or reuses) the example project under `options.targetRoot`.
 * Reuse is keyed on the project's own sapiom.json — the file the workflow
 * scanner keys on too, so "reusable" here means exactly "the rail will
 * discover it".
 */
export async function seedExampleProject(
  options: SeedExampleProjectOptions,
): Promise<SeedExampleProjectResult> {
  const root = path.resolve(options.targetRoot);
  const projectDir = path.join(root, SAMPLE_PROJECT_NAME);
  const alreadySeeded = existsSync(path.join(projectDir, "sapiom.json"));

  if (alreadySeeded && !options.force) {
    return {
      root,
      projectDir,
      created: false,
      gitInitialized: false,
      dependenciesInstalled: false,
    };
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

  await fs.writeFile(
    path.join(projectDir, "index.ts"),
    ORDER_TRIAGE_INDEX_TS,
    "utf8",
  );
  writeConfig(projectDir, { name: SAMPLE_PROJECT_NAME });

  // Install deps BEFORE the initial commit so the (gitignored) node_modules is
  // present for the Canvas's first bundle, while staying out of git history.
  const dependenciesInstalled =
    (options.installDependencies ?? true)
      ? await installProjectDependencies(projectDir)
      : false;

  commitCustomizations(projectDir);

  return {
    root,
    projectDir,
    created: true,
    gitInitialized: result.gitInitialized,
    dependenciesInstalled,
  };
}
