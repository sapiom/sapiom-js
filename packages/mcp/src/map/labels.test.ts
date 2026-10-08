import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildMap } from "./build.js";
import {
  fileLabelCache,
  labelCachePath,
  memoryLabelCache,
} from "./labels-cache.js";
import {
  LABEL_MODEL,
  labelMap,
  questionKey,
  type ChoiceQuestion,
  type Evaluate,
  type EvaluateRequest,
  type LabelCache,
  type LabelCacheData,
} from "./labels.js";
import type { MapDescription } from "./types.js";

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "jev",
);

// Support desk, as the scan describes it, plus one scaffold-fresh agent (`scratch`, no description).
async function supportDesk(): Promise<MapDescription> {
  return JSON.parse(
    await readFile(
      path.join(fixtures, "support-desk.description.json"),
      "utf8",
    ),
  );
}

// One real `decisions.evaluate` round trip for that description, recorded against jev-1.13.0.
const recorded: {
  model: string;
  request: EvaluateRequest;
  response: {
    answers: Record<
      string,
      { choice: string; probabilities: Record<string, number> }
    >;
  };
} = JSON.parse(
  await readFile(path.join(fixtures, "support-desk.recorded.json"), "utf8"),
);

/**
 * Replays the recording offline. A question the recording does not hold is answered from
 * `extra` (keyed by agent name for a role, `A>B` for an edge), or the call fails.
 */
function replay(extra: Record<string, { choice: string; p: number }> = {}) {
  const requests: EvaluateRequest[] = [];
  const evaluate: Evaluate = async (request) => {
    requests.push(request);
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(request.questions)) {
      const known = recorded.response.answers[key];
      if (known) {
        answers[key] = known;
        continue;
      }
      const instructions = question.instructions as {
        agent?: { name: string };
        A?: { name: string };
        B?: { name: string };
      };
      const subject =
        instructions.agent?.name ??
        `${instructions.A?.name}>${instructions.B?.name}`;
      const synthetic = extra[subject];
      if (!synthetic)
        throw new Error(`no recorded or synthetic answer for ${subject}`);
      answers[key] = {
        type: "choice",
        choice: synthetic.choice,
        probabilities: { [synthetic.choice]: synthetic.p },
      };
    }
    return { answers, cost: { estimateUsd: 0.0001 } };
  };
  const asked = () =>
    requests.flatMap((request) =>
      Object.values(request.questions).map(subjectOf),
    );
  return { evaluate, requests, asked };
}

function subjectOf(question: ChoiceQuestion): string {
  const instructions = question.instructions as {
    agent?: { name: string };
    A?: { name: string };
    B?: { name: string };
  };
  return instructions.agent
    ? `role:${instructions.agent.name}`
    : `edge:${instructions.A!.name}>${instructions.B!.name}`;
}

/** A project's cache in memory: answers and shown labels, as the file cache keeps them. */
function projectCache(): LabelCache {
  let data: LabelCacheData = { answers: {}, shown: {} };
  return {
    read: async () => structuredClone(data),
    write: async (next) => {
      data = structuredClone(next);
    },
  };
}

/** A two-agent map whose one role question Jev answers with `p`. */
async function oneRole(
  p: number,
  cache: LabelCache,
  description = "Writes the weekly post.",
) {
  const evaluate: Evaluate = async (request) => ({
    answers: Object.fromEntries(
      Object.keys(request.questions).map((key) => [
        key,
        { choice: "worker", probabilities: { worker: p } },
      ]),
    ),
  });
  const { map } = await labelMap(
    buildMap({ root: null, agents: [{ slug: "writer", description }] }),
    { evaluate, cache },
  );
  return map.agents[0]!.role ?? null;
}

function roles(map: {
  agents: Array<{ slug: string; role?: { value: string; p: number } }>;
}) {
  return Object.fromEntries(
    map.agents.map((agent) => [agent.slug, agent.role ?? null]),
  );
}

describe("labelMap", () => {
  it("asks one batched, pinned question per described agent and per launch or event edge, and shows only p ≥ 0.8", async () => {
    const { evaluate, requests } = replay();
    const { map, stats } = await labelMap(buildMap(await supportDesk()), {
      evaluate,
      cache: memoryLabelCache(),
    });

    expect(map.labels).toBe("ok");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe("jev-1.13.0");
    // 10 described agents (scratch is boilerplate) + 8 event edges; the 3 timer edges are not asked.
    expect(Object.keys(requests[0]!.questions)).toHaveLength(18);
    expect(stats).toMatchObject({ questions: 18, asked: 18, calls: 1 });
    expect(roles(map)).toEqual({
      controller: { value: "monitor", p: 0.98 },
      copilot: null, // worker at 0.73
      digest: { value: "reporter", p: 1 },
      escalation: { value: "worker", p: 0.89 },
      intake: { value: "intake", p: 1 },
      scratch: null, // not asked
      setup: { value: "utility", p: 1 },
      "smoke-consume": { value: "worker", p: 0.89 },
      "smoke-ingest": { value: "intake", p: 1 },
      "urgent-pager": null, // monitor at 0.55
      watchdog: { value: "monitor", p: 1 },
    });
    for (const edge of map.edges) {
      if (edge.kind === "timer") expect(edge.label).toBeUndefined();
      else expect(edge.label).toEqual({ value: "hands work to", p: 1 });
    }
  });

  it("lists every option in a fixed order", async () => {
    const { evaluate, requests } = replay();
    await labelMap(buildMap(await supportDesk()), {
      evaluate,
      cache: memoryLabelCache(),
    });
    const options = Object.values(requests[0]!.questions).map((question) =>
      Object.keys(question.criteria).join(","),
    );
    expect(new Set(options)).toEqual(
      new Set([
        "intake,worker,orchestrator,reporter,monitor,utility",
        "hands_work_to,feeds_data_to,monitors",
      ]),
    );
  });

  it("asks nothing when the cache holds every answer, and draws the same labels", async () => {
    const cache = memoryLabelCache();
    const first = await labelMap(buildMap(await supportDesk()), {
      evaluate: replay().evaluate,
      cache,
    });
    const second = replay();
    const again = await labelMap(buildMap(await supportDesk()), {
      evaluate: second.evaluate,
      cache,
    });

    expect(second.requests).toHaveLength(0);
    expect(again.stats).toMatchObject({ questions: 18, asked: 0, calls: 0 });
    expect(JSON.stringify(again.map)).toBe(JSON.stringify(first.map));
  });

  it("gives the same labels for the same input from independent caches", async () => {
    const one = await labelMap(buildMap(await supportDesk()), {
      evaluate: replay().evaluate,
      cache: memoryLabelCache(),
    });
    const two = await labelMap(buildMap(await supportDesk()), {
      evaluate: replay().evaluate,
      cache: memoryLabelCache(),
    });
    expect(JSON.stringify(two.map)).toBe(JSON.stringify(one.map));
  });

  it("re-asks only the changed agent's questions", async () => {
    const cache = memoryLabelCache();
    await labelMap(buildMap(await supportDesk()), {
      evaluate: replay().evaluate,
      cache,
    });

    const changed = await supportDesk();
    changed.agents.find((agent) => agent.slug === "copilot")!.description =
      "Support desk copilot: drafts a reply card for each issue and waits for a person to approve it.";
    const second = replay({
      copilot: { choice: "worker", p: 0.91 },
      "copilot>escalation": { choice: "hands_work_to", p: 0.95 },
      "intake>copilot": { choice: "hands_work_to", p: 0.95 },
      "smoke-ingest>copilot": { choice: "hands_work_to", p: 0.95 },
    });
    const { map } = await labelMap(buildMap(changed), {
      evaluate: second.evaluate,
      cache,
    });

    expect(second.requests).toHaveLength(1);
    expect(second.asked().sort()).toEqual([
      "edge:copilot>escalation",
      "edge:intake>copilot", // issue.created
      "edge:intake>copilot", // issue.message_added
      "edge:smoke-ingest>copilot",
      "role:copilot",
    ]);
    expect(roles(map).copilot).toEqual({ value: "worker", p: 0.91 });
    expect(roles(map).escalation).toEqual({ value: "worker", p: 0.89 });
  });

  it("compares Jev's unrounded probability with 0.8 and rounds only the shown value", async () => {
    expect(await oneRole(0.796, memoryLabelCache())).toBeNull();
    expect(await oneRole(0.8, memoryLabelCache())).toEqual({
      value: "worker",
      p: 0.8,
    });
    expect(await oneRole(0.8349, memoryLabelCache())).toEqual({
      value: "worker",
      p: 0.83,
    });
  });

  it("never carries a shown label from one described map to another with the same slug", async () => {
    const shared = memoryLabelCache();
    expect(await oneRole(0.9, shared)).toEqual({ value: "worker", p: 0.9 });
    expect(
      await oneRole(0.5, shared, "Pages the on-call engineer."),
    ).toBeNull();
  });

  it("keeps the label already shown unless a changed agent's new answer differs and clears 0.8", async () => {
    const cache = projectCache();
    const description = await supportDesk();
    const escalation = description.agents.find(
      (agent) => agent.slug === "escalation",
    )!;
    await labelMap(buildMap(description), {
      evaluate: replay().evaluate,
      cache,
    });

    escalation.description =
      "Support desk escalation: opens a Linear issue for an escalated ticket.";
    const unsure = await labelMap(buildMap(description), {
      evaluate: replay({
        escalation: { choice: "orchestrator", p: 0.7 },
        "copilot>escalation": { choice: "hands_work_to", p: 1 },
      }).evaluate,
      cache,
    });
    expect(roles(unsure.map).escalation).toEqual({ value: "worker", p: 0.89 });

    escalation.description =
      "Support desk escalation: starts the Linear and Slack agents and combines their results.";
    const sure = await labelMap(buildMap(description), {
      evaluate: replay({
        escalation: { choice: "orchestrator", p: 0.9 },
        "copilot>escalation": { choice: "hands_work_to", p: 1 },
      }).evaluate,
      cache,
    });
    expect(roles(sure.map).escalation).toEqual({
      value: "orchestrator",
      p: 0.9,
    });
  });

  it("labels launch and event edges only", async () => {
    const description: MapDescription = {
      root: null,
      agents: [
        {
          slug: "planner",
          description:
            "Plans the week's work and starts the agents that do it.",
          emits: [{ eventType: "plan.ready" }],
          calls: [
            { to: "writer", kind: "launch" },
            { to: "writer", kind: "signal" },
            { to: "writer", kind: "timer" },
          ],
        },
        {
          slug: "writer",
          description: "Writes the weekly post from the plan.",
          triggers: [
            { kind: "event", eventType: "plan.ready", source: "code" },
          ],
        },
      ],
    };
    const requests: EvaluateRequest[] = [];
    const evaluate: Evaluate = async (request) => {
      requests.push(request);
      return {
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([key, question]) => {
            const choice = Object.keys(question.criteria)[0]!;
            return [key, { choice, probabilities: { [choice]: 0.95 } }];
          }),
        ),
      };
    };
    const { map } = await labelMap(buildMap(description), {
      evaluate,
      cache: memoryLabelCache(),
    });

    const asked = Object.values(requests[0]!.questions).map(subjectOf).sort();
    expect(asked).toEqual([
      "edge:planner>writer",
      "edge:planner>writer",
      "role:planner",
      "role:writer",
    ]);
    expect(
      map.edges.map((edge) => [edge.kind, edge.label?.value ?? null]),
    ).toEqual([
      ["event", "hands work to"],
      ["launch", "hands work to"],
      ["signal", null],
      ["timer", null],
    ]);
  });

  it("splits a large map into parallel calls of at most 64 questions", async () => {
    const agents = Array.from({ length: 70 }, (_, index) => ({
      slug: `agent-${String(index).padStart(2, "0")}`,
      description: `Agent number ${index} does one job.`,
    }));
    const sizes: number[] = [];
    const evaluate: Evaluate = async (request) => {
      sizes.push(Object.keys(request.questions).length);
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) => [
            key,
            { choice: "worker", probabilities: { worker: 0.9 } },
          ]),
        ),
      };
    };
    const { stats } = await labelMap(buildMap({ root: null, agents }), {
      evaluate,
      cache: memoryLabelCache(),
    });
    expect(sizes.sort()).toEqual([6, 64]);
    expect(stats.calls).toBe(2);
  });

  describe("unavailable", () => {
    async function expectUnavailable(
      evaluate: Evaluate | undefined,
      timeoutMs?: number,
    ) {
      const built = buildMap(await supportDesk());
      const cache = memoryLabelCache();
      const { map } = await labelMap(built, {
        evaluate,
        cache,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      expect(map).toEqual(built); // labels: "unavailable", nothing else touched
      expect(await cache.read()).toEqual({ answers: {}, shown: {} });
    }

    it("when signed out (no evaluate)", () => expectUnavailable(undefined));
    it("when Jev fails", () =>
      expectUnavailable(async () => {
        throw new Error("HTTP 502");
      }));
    it("when Jev answers without a usable choice", () =>
      expectUnavailable(async (request) => ({
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) => [
            key,
            { choice: "boss" },
          ]),
        ),
      })));
    it("when Jev is slower than the timeout", () =>
      expectUnavailable(() => new Promise(() => undefined), 20));
  });
});

describe("questionKey", () => {
  const question: ChoiceQuestion = {
    type: "choice",
    instructions: {
      task: "Which role?",
      agent: { name: "a", description: "Does a thing." },
    },
    criteria: { intake: "x", worker: "y" },
  };

  it("changes with the facts, the option order and the model, and nothing else", () => {
    const key = questionKey(question);
    expect(questionKey(structuredClone(question))).toBe(key);
    expect(
      questionKey({
        ...question,
        instructions: {
          ...question.instructions,
          agent: { name: "a", description: "Other." },
        },
      }),
    ).not.toBe(key);
    expect(
      questionKey({ ...question, criteria: { worker: "y", intake: "x" } }),
    ).not.toBe(key);
    expect(questionKey(question, "jev-1.14.0")).not.toBe(key);
    expect(questionKey(question, LABEL_MODEL)).toBe(key);
  });
});

describe("fileLabelCache", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "map-labels-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps answers in .sapiom/cache/map-labels.json, ignored from inside, and rewrites nothing when unchanged", async () => {
    const cache = fileLabelCache(root);
    const first = replay();
    await labelMap(buildMap(await supportDesk()), {
      evaluate: first.evaluate,
      cache,
    });
    const file = labelCachePath(root);
    expect(file).toBe(path.join(root, ".sapiom", "cache", "map-labels.json"));
    expect(
      await readFile(path.join(root, ".sapiom", "cache", ".gitignore"), "utf8"),
    ).toBe("*\n");
    const written = await stat(file);

    const second = replay();
    const { map } = await labelMap(buildMap(await supportDesk()), {
      evaluate: second.evaluate,
      cache: fileLabelCache(root),
    });
    expect(second.requests).toHaveLength(0);
    expect(map.labels).toBe("ok");
    expect((await stat(file)).mtimeMs).toBe(written.mtimeMs);
  });

  it("starts empty from a corrupt or older file", async () => {
    const cache = fileLabelCache(root);
    await cache.write({
      answers: { k: { value: "worker", p: 0.9 } },
      shown: {},
    });
    expect((await cache.read()).answers).toEqual({
      k: { value: "worker", p: 0.9 },
    });

    await writeFile(labelCachePath(root), "{not json");
    expect(await cache.read()).toEqual({ answers: {}, shown: {} });
    await writeFile(
      labelCachePath(root),
      JSON.stringify({
        version: 0,
        answers: { k: { value: "worker", p: 0.9 } },
      }),
    );
    expect(await cache.read()).toEqual({ answers: {}, shown: {} });
  });
});
