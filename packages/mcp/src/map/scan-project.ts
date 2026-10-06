/**
 * `{ root, ref? }` → the map description: find the agents under `root`, read what their code
 * proves (code-facts.ts), their steps (`agents check`), the project's declared triggers
 * (`fleet.json`), and, when signed in, the platform's triggers and deploy state. Nothing is
 * stored; the same tree and account give the same description.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { agentCodeFacts, declaresAgent, ProjectSources, type AgentCodeFacts } from "./code-facts.js";
import type {
  DescribedAgent,
  DescribedCall,
  DescribedTrigger,
  Evidence,
  MapDescription,
  PlatformState,
  StepGraph,
  Unresolved,
} from "./types.js";

const execFileAsync = promisify(execFile);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".sapiom",
  ".sapiom-dev",
  ".claude",
  "test",
  "tests",
  "__tests__",
  "__fixtures__",
  "fixtures",
]);
const DISCOVERY_DEPTH = 4;
const STEP_CONCURRENCY = 4;

/** Platform facts for a set of slugs; injected so tests and offline callers never touch the network. */
export interface PlatformSource {
  /** Slugs (and names) of definitions on the signed-in account. */
  deployedSlugs(): Promise<ReadonlySet<string>>;
  /** Active triggers for one definition slug. */
  triggers(slug: string): Promise<DescribedTrigger[]>;
}

/** An agent folder → its `agents check` manifest, or why there is none. */
export type StepSource = (agentDir: string) => Promise<{ manifest: unknown } | { unavailable: string }>;

export interface ScanOptions {
  root: string;
  ref?: string;
  /** null: signed out. undefined: platform facts skipped. */
  platform?: PlatformSource | null;
  steps?: StepSource | false;
}

interface FoundAgent {
  dir: string;
  /** Folder key: the `fleet.json` project key, or the folder name. */
  key: string;
  sapiomJson: SapiomJson | null;
  packageJson: { name?: string; description?: string } | null;
}

const sapiomJsonSchema = z
  .object({
    name: z.string().optional(),
    definitionId: z.union([z.string(), z.number()]).optional(),
    resources: z
      .record(z.object({ env: z.record(z.string()).optional() }).passthrough())
      .optional(),
  })
  .passthrough();
type SapiomJson = z.infer<typeof sapiomJsonSchema>;

const fleetJsonSchema = z
  .object({
    projects: z.array(z.object({ key: z.string(), path: z.string() }).passthrough()).default([]),
    triggers: z
      .array(
        z
          .object({
            project: z.string(),
            kind: z.string().optional(),
            eventType: z.string().optional(),
            cron: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
    smokeTriggers: z
      .array(
        z
          .object({
            project: z.string(),
            kind: z.string().optional(),
            eventType: z.string().optional(),
            cron: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
    connectors: z
      .array(z.object({ provider: z.string(), requiredBy: z.array(z.string()).default([]) }).passthrough())
      .default([]),
  })
  .passthrough();
type FleetJson = z.infer<typeof fleetJsonSchema>;

const mapJsonSchema = z.object({
  systems: z.array(z.object({ agent: z.string(), name: z.string().min(1) })).default([]),
});

async function readJson(file: string): Promise<{ value: unknown; text: string } | null> {
  try {
    const text = await fs.readFile(file, "utf8");
    return { value: JSON.parse(text), text };
  } catch {
    return null;
  }
}

function posix(relative: string): string {
  return relative.split(path.sep).join(path.posix.sep);
}

/** The 1-based line of the first occurrence of `needle` in `text`, for JSON evidence. */
function lineOf(text: string, needle: string): number {
  const index = text.indexOf(needle);
  return index < 0 ? 1 : text.slice(0, index).split("\n").length;
}

async function discoverAgents(root: string, fleet: FleetJson | null): Promise<FoundAgent[]> {
  const found = new Map<string, FoundAgent>();
  const keysByDir = new Map<string, string>();
  for (const project of fleet?.projects ?? []) {
    keysByDir.set(path.resolve(root, project.path), project.key);
  }
  const visit = async (dir: string, depth: number): Promise<void> => {
    const sapiom = await readJson(path.join(dir, "sapiom.json"));
    const isAgent = keysByDir.has(dir) || sapiom !== null || (await declaresAgent(dir));
    if (isAgent && dir !== root) {
      const parsed = sapiom ? sapiomJsonSchema.safeParse(sapiom.value) : null;
      const pkg = await readJson(path.join(dir, "package.json"));
      found.set(dir, {
        dir,
        key: keysByDir.get(dir) ?? path.basename(dir),
        sapiomJson: parsed?.success ? parsed.data : null,
        packageJson: (pkg?.value as FoundAgent["packageJson"]) ?? null,
      });
      return; // agents do not nest
    }
    if (depth >= DISCOVERY_DEPTH) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await visit(path.join(dir, entry.name), depth + 1);
    }
  };
  await visit(root, 0);
  return [...found.values()].sort((left, right) => (left.dir < right.dir ? -1 : 1));
}

function manifestToSteps(
  manifest: unknown,
  locations: ReadonlyMap<string, { file: string; line: number }>,
): StepGraph | null {
  const parsed = z
    .object({
      entry: z.string(),
      steps: z.record(
        z.object({
          transitions: z
            .array(
              z
                .object({
                  kind: z.string(),
                  target: z.string().optional(),
                  resumeStep: z.string().optional(),
                })
                .passthrough(),
            )
            .default([]),
        }).passthrough(),
      ),
    })
    .safeParse(manifest);
  if (!parsed.success) return null;
  const names = Object.keys(parsed.data.steps).sort();
  return {
    entry: parsed.data.entry,
    steps: names.map((id) => ({ id, ...(locations.get(id) ?? {}) })),
    transitions: names.flatMap((from) =>
      parsed.data.steps[from]!.transitions.flatMap((transition) => {
        const to = transition.kind === "pause" ? transition.resumeStep : transition.target;
        return to ? [{ from, to, kind: transition.kind }] : [];
      }),
    ),
  };
}

/** Steps through `agents check` (bundles and loads the agent; needs its dependencies installed). */
export const checkSteps: StepSource = async (agentDir) => {
  try {
    await fs.access(path.join(agentDir, "index.ts"));
  } catch {
    return { unavailable: "no index.ts: not a defineAgent project (a sandbox app or server)" };
  }
  try {
    const { check } = await import("@sapiom/agent-core");
    const result = await check({ sourceDir: agentDir, typecheck: false });
    return { manifest: result.manifest };
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
    return { unavailable: code ? `agents check failed (${code}): ${message}` : message };
  }
};

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

interface GitView {
  /** Where the scan reads files: the root itself, or an extracted copy at `ref`. */
  scanRoot: string;
  ref?: string;
  changed(agentRelative: string): Promise<boolean>;
  dispose(): Promise<void>;
}

async function gitView(root: string, ref: string | undefined): Promise<GitView> {
  const top = (await git(root, ["rev-parse", "--show-toplevel"]))?.trim();
  const none: GitView = { scanRoot: root, changed: async () => false, dispose: async () => {} };
  if (!top) {
    if (ref) throw new MapInputError("NOT_A_GIT_REPO", `${root} is not in a git repository, so it has no ref "${ref}"`);
    return none;
  }
  const base = ref ?? "HEAD";
  if (ref && !(await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]))) {
    throw new MapInputError("UNKNOWN_REF", `No commit "${ref}" in ${top}`);
  }
  const hasHead = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])) !== null;
  // changedSinceRef: the working copy differs from `ref` (from HEAD when drawing the working copy).
  const changed = async (agentRelative: string): Promise<boolean> => {
    const target = agentRelative || ".";
    if (!hasHead && !ref) return true;
    const diff = await git(root, ["diff", "--name-only", base, "--", target]);
    const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "--", target]);
    return Boolean(diff?.trim() || untracked?.trim());
  };
  if (!ref) return { scanRoot: root, ref: "working", changed, dispose: async () => {} };

  const prefix = posix(path.relative(top, root));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "sapiom-map-"));
  const archive = path.join(temp, "ref.tar");
  await execFileAsync("git", ["-C", top, "archive", "--format=tar", "-o", archive, ref, "--", prefix || "."]);
  await execFileAsync("tar", ["-xf", archive, "-C", temp]);
  await fs.rm(archive);
  return {
    scanRoot: path.join(temp, prefix),
    ref,
    changed,
    dispose: () => fs.rm(temp, { recursive: true, force: true }),
  };
}

export class MapInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function slugFor(agent: FoundAgent, facts: AgentCodeFacts): string {
  return (
    agent.sapiomJson?.name ??
    facts.declaredName ??
    agent.packageJson?.name ??
    path.basename(agent.dir)
  );
}

export async function describeProject(options: ScanOptions): Promise<MapDescription> {
  const requested = path.resolve(options.root);
  const stat = await fs.stat(requested).catch(() => null);
  if (!stat?.isDirectory()) throw new MapInputError("NOT_A_DIRECTORY", `${requested} is not a directory`);
  // Git reports the real path; a root reached through a symlink would sit "outside" its repo.
  const root = await fs.realpath(requested);
  const view = await gitView(root, options.ref);
  try {
    return await describeAt(root, view, options);
  } finally {
    await view.dispose();
  }
}

async function describeAt(root: string, view: GitView, options: ScanOptions): Promise<MapDescription> {
  const scanRoot = view.scanRoot;
  const fleetRead = await readJson(path.join(scanRoot, "fleet.json"));
  const fleetParsed = fleetRead ? fleetJsonSchema.safeParse(fleetRead.value) : null;
  const fleet = fleetParsed?.success ? fleetParsed.data : null;
  const found = await discoverAgents(scanRoot, fleet);

  // Steps first: their names bound which `defineStep` block a call is attributed to.
  const stepSource = options.steps === false ? null : (options.steps ?? checkSteps);
  const stepResults = new Map<string, { manifest: unknown } | { unavailable: string }>();
  if (stepSource) {
    const results = await mapLimit(found, STEP_CONCURRENCY, async (agent) => {
      // A ref is extracted without dependencies; borrow the working copy's so check can bundle.
      if (scanRoot !== root) {
        const working = path.join(root, path.relative(scanRoot, agent.dir), "node_modules");
        await fs.symlink(working, path.join(agent.dir, "node_modules"), "dir").catch(() => {});
      }
      return stepSource(agent.dir);
    });
    found.forEach((agent, index) => stepResults.set(agent.dir, results[index]));
  }
  const knownSteps = (dir: string): ReadonlySet<string> | null => {
    const result = stepResults.get(dir);
    const manifest = result && "manifest" in result ? (result.manifest as { steps?: unknown }) : null;
    const steps = manifest?.steps;
    return steps && typeof steps === "object" ? new Set(Object.keys(steps)) : null;
  };

  const sources = new ProjectSources(scanRoot, knownSteps);
  const facts = new Map<string, AgentCodeFacts>();
  for (const agent of found) {
    const env: Record<string, string> = {};
    for (const resource of Object.values(agent.sapiomJson?.resources ?? {})) {
      Object.assign(env, resource.env ?? {});
    }
    facts.set(agent.dir, await agentCodeFacts(sources, agent.dir, env));
  }

  const slugByDir = new Map(found.map((agent) => [agent.dir, slugFor(agent, facts.get(agent.dir)!)]));
  const knownSlugs = new Set(slugByDir.values());
  const slugByKey = new Map(found.map((agent) => [agent.key, slugByDir.get(agent.dir)!]));
  // A target names an agent by slug, or by its folder / fleet key (`agentSlug("controller")`).
  const resolveTarget = (value: string): string | null =>
    knownSlugs.has(value) ? value : (slugByKey.get(value) ?? null);

  const platformState: PlatformState =
    options.platform === undefined ? "skipped" : options.platform === null ? "signed-out" : "signed-in";
  let deployed: ReadonlySet<string> | null = null;
  let platform = options.platform ?? null;
  let state: PlatformState = platformState;
  if (platform) {
    try {
      deployed = await platform.deployedSlugs();
    } catch {
      platform = null;
      state = "unavailable";
    }
  }

  const unresolved: Unresolved[] = [];
  const agents: DescribedAgent[] = [];
  for (const agent of found) {
    const slug = slugByDir.get(agent.dir)!;
    const code = facts.get(agent.dir)!;
    const relative = posix(path.relative(scanRoot, agent.dir));

    const calls: DescribedCall[] = [];
    for (const call of code.calls) {
      if (!call.targets) {
        unresolved.push({ from: slug, kind: call.kind, reason: "dynamic-target", evidence: [call.evidence] });
        continue;
      }
      for (const target of call.targets) {
        const to = resolveTarget(target.value);
        if (to) calls.push({ to, kind: call.kind, evidence: [call.evidence] });
        else if (!target.alias) calls.push({ to: target.value, kind: call.kind, evidence: [call.evidence] });
        else unresolved.push({ from: slug, kind: call.kind, reason: "dynamic-target", evidence: [call.evidence] });
      }
    }
    for (const evidence of code.dynamicEmits) {
      unresolved.push({ from: slug, kind: "event", reason: "dynamic-target", evidence: [evidence] });
    }

    // A sandbox server launched with another agent's slug in its sapiom.json env.
    const sapiomText = (await readJson(path.join(agent.dir, "sapiom.json")))?.text ?? "";
    for (const resource of Object.values(agent.sapiomJson?.resources ?? {})) {
      for (const [key, value] of Object.entries(resource.env ?? {})) {
        if (value === slug || !knownSlugs.has(value)) continue;
        calls.push({
          to: value,
          kind: "launch",
          evidence: [
            {
              file: posix(path.join(relative, "sapiom.json")),
              line: lineOf(sapiomText, `"${key}"`),
              text: `"${key}": "${value}"`,
            },
          ],
        });
      }
    }

    const triggers: DescribedTrigger[] = [];
    for (const trigger of [...(fleet?.triggers ?? []), ...(fleet?.smokeTriggers ?? [])]) {
      if (trigger.project !== agent.key) continue;
      const evidence: Evidence = {
        file: "fleet.json",
        line: lineOf(fleetRead!.text, trigger.eventType ? `"${trigger.eventType}"` : `"${trigger.cron}"`),
        text: trigger.eventType ? `event ${trigger.eventType}` : `cron ${trigger.cron}`,
      };
      if (trigger.eventType) triggers.push({ kind: "event", eventType: trigger.eventType, source: "code", evidence: [evidence] });
      else if (trigger.cron) triggers.push({ kind: "schedule", cron: trigger.cron, source: "code", evidence: [evidence] });
    }
    if (platform && deployed?.has(slug)) {
      try {
        triggers.push(...(await platform.triggers(slug)));
      } catch {
        state = "unavailable";
      }
    }

    const resources = new Set(code.resources);
    for (const connector of fleet?.connectors ?? []) {
      if (connector.requiredBy.includes(agent.key)) resources.add(`connector:${connector.provider}`);
    }

    const stepResult = stepResults.get(agent.dir);
    const described: DescribedAgent = {
      slug,
      path: relative,
      description: code.declaredDescription ?? agent.packageJson?.description ?? "",
      deployed: deployed
        ? deployed.has(slug)
        : agent.sapiomJson?.definitionId !== undefined
          ? true
          : null,
      changedSinceRef: await view.changed(posix(path.relative(scanRoot, agent.dir))),
      calls,
      emits: code.emits.map((emit) => ({ eventType: emit.eventType, evidence: [emit.evidence] })),
      triggers,
      resources: [...resources].sort(),
    };
    if (stepResult && "unavailable" in stepResult) described.stepsUnavailable = stepResult.unavailable;
    else if (stepResult) {
      const steps = manifestToSteps(stepResult.manifest, code.stepLocations);
      if (steps) described.steps = steps;
      else described.stepsUnavailable = "agents check returned a manifest this map cannot read";
    } else if (stepSource === null) described.stepsUnavailable = "steps not requested";
    agents.push(described);
  }

  const names = await readJson(path.join(scanRoot, ".sapiom", "map.json"));
  const parsedNames = names ? mapJsonSchema.safeParse(names.value) : null;

  const description: MapDescription = {
    root,
    agents,
    unresolved,
    platform: state,
  };
  if (view.ref) description.ref = view.ref;
  if (parsedNames?.success && parsedNames.data.systems.length > 0) description.names = parsedNames.data.systems;
  return description;
}
