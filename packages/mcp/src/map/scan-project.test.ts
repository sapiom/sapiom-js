import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { buildMap } from "./build.js";
import { checkSteps, describeProject, type PlatformSource, type StepSource } from "./scan-project.js";
import type { AgentMap } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "__fixtures__");
const SUPPORT_DESK = path.resolve(here, "../../../../examples/support-desk");

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function copyFixture(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sapiom-map-test-"));
  temps.push(dir);
  await fs.cp(path.join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

async function mapOf(root: string, options: { ref?: string; platform?: PlatformSource | null; steps?: StepSource | false } = {}) {
  return buildMap(await describeProject({ root, steps: false, ...options }));
}

const loose = (map: AgentMap) => {
  const grouped = new Set(map.systems.flatMap((system) => system.agents));
  return map.agents.filter((agent) => !grouped.has(agent.slug)).map((agent) => agent.slug);
};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: "ignore",
  });
}

describe("describeProject", () => {
  it("payouts: a const-target call makes a system; a shared database and vault key stay chips", async () => {
    const map = await mapOf(await copyFixture("map-payouts"));

    expect(map.systems.map((system) => system.agents)).toEqual([["award", "payout"]]);
    expect(loose(map)).toEqual(["dashboard", "ledger-report"]);
    expect(map.edges).toEqual([
      {
        from: "award",
        to: "payout",
        kind: "launch",
        evidence: [
          {
            file: "award/index.ts",
            line: 16,
            text: "ctx.sapiom.agents.run({ definition: PAYOUT_AGENT, input: {} });",
            step: "pay",
          },
        ],
        fromStep: "pay",
      },
    ]);
    const shared = Object.fromEntries(map.agents.map((agent) => [agent.slug, agent.shared]));
    expect(shared).toEqual({
      award: [],
      dashboard: [],
      "ledger-report": ["db:office", "vault:PAYMENTS_KEY"],
      payout: ["db:office", "vault:PAYMENTS_KEY"],
    });
    expect(map.agents.find((agent) => agent.slug === "award")!.deployed).toBe(true);
    expect(map.agents.find((agent) => agent.slug === "payout")!.deployed).toBeNull();
    expect(map.ref).toBeUndefined();
  });

  it("brain: env slugs, imported const maps, helper-wrapped launches and zod defaults join one named system", async () => {
    const map = await mapOf(await copyFixture("map-brain"));

    expect(map.systems).toEqual([
      expect.objectContaining({
        name: "Proposal pipeline",
        nameSource: "file",
        agents: ["analyze", "door", "eval", "expert-a", "expert-b", "propose"],
      }),
    ]);
    expect(loose(map)).toEqual(["survey"]);
    expect(map.edges.map((edge) => [edge.from, edge.to, edge.evidence[0]!.file, edge.evidence[0]!.line])).toEqual([
      ["door", "analyze", "door/sapiom.json", 8],
      ["eval", "propose", "eval/index.ts", 12],
      ["propose", "analyze", "propose/index.ts", 13],
      ["propose", "expert-a", "propose/index.ts", 21],
      ["propose", "expert-b", "propose/index.ts", 21],
    ]);
    expect(map.unresolved.map((item) => [item.from, item.reason, item.to ?? null, item.evidence[0]!.line])).toEqual([
      ["propose", "dynamic-target", null, 29],
      ["propose", "unknown-target", "expert-gone", 21],
    ]);
    expect(map.agents.find((agent) => agent.slug === "door")!.description).toBe("Front door server.");
  });

  it("support desk: emit wrappers and shared timers form one system; byte-identical on every run", async () => {
    const first = await mapOf(SUPPORT_DESK);
    const second = await mapOf(SUPPORT_DESK);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.systems).toHaveLength(1);
    expect(first.systems[0]!.agents).toEqual(
      expect.arrayContaining([
        "support-desk-intake",
        "support-desk-copilot",
        "support-desk-escalation",
        "support-desk-controller",
        "support-desk-urgent-pager",
        "support-desk-smoke-ingest",
        "support-desk-smoke-consume",
      ]),
    );
    expect(loose(first)).toEqual(["support-desk-digest", "support-desk-setup", "support-desk-watchdog"]);
    expect(first.edges).toContainEqual(
      expect.objectContaining({ from: "support-desk-intake", to: "support-desk-copilot", kind: "event", eventType: "issue.created" }),
    );
    expect(first.edges).toContainEqual(
      expect.objectContaining({ from: "support-desk-escalation", to: "support-desk-controller", kind: "timer" }),
    );
    for (const edge of first.edges) {
      expect(edge.evidence.length).toBeGreaterThan(0);
      for (const evidence of edge.evidence) expect(evidence.line).toBeGreaterThan(0);
    }
  });

  it("reads steps from agents check and attributes calls to the step that makes them", async () => {
    const root = await copyFixture("map-payouts");
    const steps: StepSource = async (dir) =>
      path.basename(dir) === "award"
        ? {
            manifest: {
              entry: "pick",
              steps: {
                pick: { transitions: [{ kind: "continue", target: "pay" }] },
                pay: { transitions: [{ kind: "terminate" }] },
              },
            },
          }
        : { unavailable: "no index.ts" };

    const award = (await mapOf(root, { steps })).agents.find((agent) => agent.slug === "award")!;

    expect(award.steps).toEqual({
      entry: "pick",
      steps: [
        { id: "pay", file: "award/index.ts", line: 13 },
        { id: "pick", file: "award/index.ts", line: 5 },
      ],
      transitions: [{ from: "pick", to: "pay", kind: "continue" }],
    });
  });

  it("platform: account triggers join agents; deploy state comes from the account", async () => {
    const root = await copyFixture("map-payouts");
    await fs.writeFile(
      path.join(root, "payout", "index.ts"),
      (await fs.readFile(path.join(root, "payout", "index.ts"), "utf8")).replace(
        'await ctx.sapiom.vault.get("PAYMENTS_KEY");',
        'await ctx.sapiom.events.emit({ type: "payout.sent", payload: {} });',
      ),
    );
    const platform: PlatformSource = {
      deployedSlugs: async () => new Set(["payout", "ledger-report"]),
      triggers: async (slug) => (slug === "ledger-report" ? [{ kind: "event", eventType: "payout.sent", source: "platform" }] : []),
    };

    const map = await mapOf(root, { platform });

    expect(map.platform).toBe("signed-in");
    expect(map.systems.map((system) => system.agents)).toEqual([["award", "ledger-report", "payout"]]);
    expect(Object.fromEntries(map.agents.map((agent) => [agent.slug, agent.deployed]))).toEqual({
      award: false,
      dashboard: false,
      "ledger-report": true,
      payout: true,
    });
  });

  it("signed out or unreachable: the map still draws and says why platform facts are missing", async () => {
    const root = await copyFixture("map-payouts");
    expect((await mapOf(root, { platform: null })).platform).toBe("signed-out");
    const down: PlatformSource = {
      deployedSlugs: async () => {
        throw new Error("ECONNREFUSED");
      },
      triggers: async () => [],
    };
    const map = await mapOf(root, { platform: down });
    expect(map.platform).toBe("unavailable");
    expect(map.systems).toHaveLength(1);
  });

  it("git: draws a ref, and marks agents whose folder differs from it", async () => {
    const root = await copyFixture("map-payouts");
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");
    // Working copy: ledger-report starts calling award.
    const file = path.join(root, "ledger-report", "index.ts");
    await fs.writeFile(
      file,
      (await fs.readFile(file, "utf8")).replace(
        'ctx.logger.info("see award for context");',
        'await ctx.sapiom.agents.launch({ definition: "award", input: {} });',
      ),
    );

    const working = await mapOf(root);
    expect(working.ref).toBe("working");
    expect(working.systems[0]!.agents).toEqual(["award", "ledger-report", "payout"]);
    expect(working.agents.filter((agent) => agent.changedSinceRef).map((agent) => agent.slug)).toEqual(["ledger-report"]);

    const head = await mapOf(root, { ref: "HEAD" });
    expect(head.ref).toBe("HEAD");
    expect(head.systems[0]!.agents).toEqual(["award", "payout"]);
    expect(head.root).toBe(working.root);
    expect(head.agents.filter((agent) => agent.changedSinceRef).map((agent) => agent.slug)).toEqual(["ledger-report"]);
  });

  it("refuses a ref outside a git repository and an unknown ref", async () => {
    const plain = await copyFixture("map-payouts");
    await expect(describeProject({ root: plain, ref: "HEAD", steps: false })).rejects.toMatchObject({
      code: "NOT_A_GIT_REPO",
    });
    git(plain, "init", "-q");
    git(plain, "add", "-A");
    git(plain, "commit", "-qm", "base");
    await expect(describeProject({ root: plain, ref: "no-such-branch", steps: false })).rejects.toMatchObject({
      code: "UNKNOWN_REF",
    });
  });
});

async function project(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sapiom-map-project-"));
  temps.push(dir);
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), content);
  }
  return dir;
}

const agentSource = (name: string, body = "") => `import { defineAgent, defineStep, terminate } from "@sapiom/agent";
${body}
const work = defineStep({ name: "work", async run(input: any, ctx: any) { return terminate({}); } });
export const agent = defineAgent({ name: "${name}", entry: "work", steps: { work } });
`;

const edgesOf = (map: AgentMap) => map.edges.map((edge) => `${edge.from}->${edge.to}`);

describe("describeProject edge cases", () => {
  it("maps a root that is itself an agent folder", async () => {
    const root = await project({ "sapiom.json": '{ "name": "solo" }', "index.ts": agentSource("solo") });

    const map = await mapOf(root);

    expect(map.agents.map((agent) => [agent.slug, agent.path])).toEqual([["solo", ""]]);
  });

  it("counts a shared file's calls only for the agents that reach them", async () => {
    const root = await project({
      "_shared/helpers.ts": `export const STATUS = "open";
export async function send(ctx: any) { await ctx.sapiom.agents.run({ definition: "payout", input: {} }); }
`,
      "intake/index.ts": agentSource("intake", `import { STATUS } from "../_shared/helpers";\nconsole.log(STATUS);`),
      "billing/index.ts": agentSource("billing", `import { send } from "../_shared/helpers";\nexport const go = send;`),
      "payout/index.ts": agentSource("payout"),
    });

    expect(edgesOf(await mapOf(root))).toEqual(["billing->payout"]);
  });

  it("a fixed index picks one entry; a dynamic entry is reported, not dropped", async () => {
    const root = await project({
      "router/index.ts": agentSource(
        "router",
        `const TARGETS = { primary: "alpha", secondary: "beta", other: process.env.OTHER_AGENT };
export async function a(ctx: any) { await ctx.sapiom.agents.run({ definition: TARGETS["primary"] }); }
export async function b(ctx: any, id: string) { await ctx.sapiom.agents.run({ definition: TARGETS[id] }); }`,
      ),
      "alpha/index.ts": agentSource("alpha"),
      "beta/index.ts": agentSource("beta"),
    });

    const map = await mapOf(root);

    expect(map.edges.map((edge) => [edge.to, edge.evidence.map((item) => item.line)])).toEqual([
      ["alpha", [3, 4]],
      ["beta", [4]],
    ]);
    expect(map.unresolved.map((item) => [item.reason, item.evidence[0]!.line])).toEqual([["dynamic-target", 4]]);
  });

  it("reads a launch from sapiom.json env only under a key that names an agent", async () => {
    const root = await project({
      "door/sapiom.json": '{ "resources": { "web": { "env": { "NOTE": "worker", "WORKER_SLUG": "worker" } } } }',
      "worker/index.ts": agentSource("worker"),
    });

    const map = await mapOf(root);

    expect(map.edges.map((edge) => edge.evidence[0]!.text)).toEqual(['"WORKER_SLUG": "worker"']);
  });

  it("uses a zod default only for the input the step itself reads", async () => {
    const root = await project({
      "caller/index.ts": agentSource(
        "caller",
        `import { z } from "zod/v4";
const schema = z.object({ definition: z.string().default("callee") });
const other = { settings: { definition: "x" } };
export async function own(input: { definition: string }, ctx: any) { await [1].map(async () => ctx.sapiom.agents.run({ definition: input.definition })); }
export async function notOwn(ctx: any) { await ctx.sapiom.agents.run({ definition: other.settings.definition }); }`,
      ),
      "callee/index.ts": agentSource("callee"),
    });

    const map = await mapOf(root);

    expect(edgesOf(map)).toEqual(["caller->callee"]);
    expect(map.unresolved).toHaveLength(1);
  });

  it("sees a module created after an earlier map call", async () => {
    const root = await project({
      "caller/index.ts": agentSource(
        "caller",
        `import { TARGET } from "./targets";\nexport async function go(ctx: any) { await ctx.sapiom.agents.run({ definition: TARGET }); }`,
      ),
      "callee/index.ts": agentSource("callee"),
    });
    expect(edgesOf(await mapOf(root))).toEqual([]);

    await fs.writeFile(path.join(root, "caller", "targets.ts"), 'export const TARGET = "callee";\n');

    expect(edgesOf(await mapOf(root))).toEqual(["caller->callee"]);
  });

  it("refuses a ref that git would read as an option", async () => {
    const root = await copyFixture("map-payouts");
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");

    await expect(describeProject({ root, ref: "--output=/tmp/x", steps: false })).rejects.toMatchObject({
      code: "UNKNOWN_REF",
    });
  });
});

describe("checkSteps", () => {
  it("survives agent code that exits the process on load", async () => {
    const root = await project({ "index.ts": "process.exit(0);\n" });

    const result = await checkSteps(root);

    expect(result).toEqual({ unavailable: expect.stringMatching(/agents check/) });
  });
});

describe("describeProject review round 2", () => {
  it("searches a root with its own sapiom.json for child agents first", async () => {
    const root = await project({
      "sapiom.json": '{ "name": "desk" }',
      "fleet.json": '{ "projects": [{ "key": "intake", "path": "agents/intake" }] }',
      "agents/intake/index.ts": agentSource("intake"),
      "agents/worker/index.ts": agentSource("worker"),
    });

    expect((await mapOf(root)).agents.map((agent) => agent.slug)).toEqual(["intake", "worker"]);
  });

  it("counts a launch in an imported file's top-level initializer", async () => {
    const root = await project({
      "_shared/boot.ts": `export const STATUS = "open";
declare const ctx: any;
const started = ctx.sapiom.agents.launch({ definition: "worker" });
export function unused(ctx: any) { return ctx.sapiom.agents.run({ definition: "other" }); }
`,
      "app/index.ts": agentSource("app", `import { STATUS } from "../_shared/boot";\nconsole.log(STATUS);`),
      "worker/index.ts": agentSource("worker"),
      "other/index.ts": agentSource("other"),
    });

    expect(edgesOf(await mapOf(root))).toEqual(["app->worker"]);
  });

  it("treats a fixed key as dynamic when a computed key could overwrite it", async () => {
    const root = await project({
      "router/index.ts": agentSource(
        "router",
        `const key = process.argv[2];
const TARGETS = { primary: "alpha", [key]: "beta" };
export async function a(ctx: any) { await ctx.sapiom.agents.run({ definition: TARGETS["primary"] }); }`,
      ),
      "alpha/index.ts": agentSource("alpha"),
    });

    const map = await mapOf(root);

    expect(map.edges).toEqual([]);
    expect(map.unresolved.map((item) => item.reason)).toEqual(["dynamic-target"]);
  });
});

describe("describeProject review round 3", () => {
  it("names both folders when two agents share a slug", async () => {
    const root = await project({
      "a/sapiom.json": '{ "name": "same" }',
      "legacy/a/sapiom.json": '{ "name": "same" }',
    });

    await expect(describeProject({ root, steps: false })).rejects.toMatchObject({
      code: "DUPLICATE_AGENT",
      message: expect.stringContaining("a and legacy/a"),
    });
  });
});
