import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { buildMap } from "./build.js";
import { describeProject, type PlatformSource, type StepSource } from "./scan-project.js";
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
