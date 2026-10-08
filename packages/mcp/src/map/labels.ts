/**
 * Jev labels on a built map (design §4): an agent's role, and the label of an edge a launch or
 * an event backs. A separate async step after `buildMap`, so the map itself stays a pure
 * function of the description; the Jev call and the cache are injected.
 *
 * Stability comes from three rules. Each question's state holds only the facts it needs, so
 * the same code gives the same cache key and is never re-asked. A label shows only at
 * p ≥ 0.8. When facts change and a question is re-asked, the label already shown stays unless
 * the new answer differs and clears 0.8 itself.
 */
import { createHash } from "node:crypto";

import type {
  AgentMap,
  AgentRole,
  EdgeLabel,
  Label,
  MapAgent,
  MapEdge,
} from "./types.js";

export const LABEL_MODEL = "jev-1.13.0";
export const LABEL_THRESHOLD = 0.8;
/** A slow Jev never blocks the map: past this the map comes back with `labels: "unavailable"`. */
export const LABEL_TIMEOUT_MS = 5_000;
/** Questions per `decisions.evaluate` request; a larger map sends its chunks in parallel. */
const QUESTIONS_PER_CALL = 64;
/** Past this many cached answers, a write keeps only the ones the current map uses. */
const MAX_CACHED_ANSWERS = 2_000;

// Option order is fixed: Jev favours the first option, and the cache key covers the order.
const ROLE_CRITERIA: ReadonlyArray<readonly [AgentRole, string]> = [
  [
    "intake",
    "Receives outside input (a chat message, webhook, form, or visitor request) and turns it into work or records for the rest of the project.",
  ],
  [
    "worker",
    "Does one focused job when it is started, and returns or records the result.",
  ],
  [
    "orchestrator",
    "Coordinates other agents: starts them, waits for them, and combines their results.",
  ],
  [
    "reporter",
    "Produces a report, digest, post, or page for people, usually on a schedule or at the end of a flow.",
  ],
  [
    "monitor",
    "Watches other agents, apps, or data for failure, staleness, or health problems and alerts or repairs.",
  ],
  [
    "utility",
    "Setup, testing, benchmarking, hosting, or other support code outside the normal flow.",
  ],
];

const EDGE_CRITERIA: ReadonlyArray<readonly [string, string, EdgeLabel]> = [
  [
    "hands_work_to",
    "A starts B, schedules B, or emits an event that B acts on, so B does the next part of the job.",
    "hands work to",
  ],
  [
    "feeds_data_to",
    "A writes data that B reads later; A does not start B.",
    "feeds data to",
  ],
  [
    "monitors",
    "A watches B's runs, health, or output for problems.",
    "monitors",
  ],
];

const STATE =
  "Agents in one software project, and how their code connects them.";

/** What a scaffold leaves when nobody has described the agent yet. */
const BOILERPLATE =
  /^a sapiom (agent|orchestration)(, authored as code.*)?\.?$/i;

export interface ChoiceQuestion {
  type: "choice";
  instructions: Record<string, unknown>;
  criteria: Record<string, string>;
}

export interface EvaluateRequest {
  model: string;
  state: string;
  questions: Record<string, ChoiceQuestion>;
}

/** One `decisions.evaluate` round trip. Resolves to the response body. */
export type Evaluate = (request: EvaluateRequest) => Promise<unknown>;

export interface CachedAnswer {
  value: string;
  p: number;
}

export interface LabelCacheData {
  /** Jev's answer by question key: a hash of the question's state, its options and the model. */
  answers: Record<string, CachedAnswer>;
  /** The label last shown per subject (`role:<slug>`, `edge:<from>><to>:<kind>:<event>`). */
  shown: Record<string, CachedAnswer>;
}

export interface LabelCache {
  read(): Promise<LabelCacheData>;
  write(data: LabelCacheData): Promise<void>;
}

export interface LabelOptions {
  /** Absent when signed out or `platform: false`: no network, `labels: "unavailable"`. */
  evaluate?: Evaluate;
  cache: LabelCache;
  timeoutMs?: number;
}

export interface LabelStats {
  questions: number;
  /** Questions sent to Jev (the rest came from the cache). */
  asked: number;
  calls: number;
  costUsd: number;
}

export interface LabelResult {
  map: AgentMap;
  stats: LabelStats;
}

interface PendingQuestion {
  subject: string;
  key: string;
  question: ChoiceQuestion;
  apply: (answer: CachedAnswer) => void;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

export function isBoilerplate(
  agent: Pick<MapAgent, "slug" | "description">,
): boolean {
  const text = agent.description.trim();
  return text === "" || text === agent.slug || BOILERPLATE.test(text);
}

export function questionKey(
  question: ChoiceQuestion,
  model = LABEL_MODEL,
): string {
  // Criteria go in as ordered pairs: reordering the options is a different question.
  const material = JSON.stringify([
    STATE,
    question.instructions,
    Object.entries(question.criteria),
    model,
  ]);
  return createHash("sha256").update(material).digest("hex");
}

function roleQuestion(agent: MapAgent, map: AgentMap): ChoiceQuestion {
  const card: Record<string, unknown> = {
    name: agent.slug,
    description: clip(agent.description.trim(), 320),
  };
  if (agent.steps) card.steps = agent.steps.steps.map((step) => step.id);
  const starts = sortedUnique(
    map.edges
      .filter((e) => e.from === agent.slug && e.kind !== "event")
      .map((e) => e.to),
  );
  const notifies = sortedUnique(
    map.edges
      .filter((e) => e.from === agent.slug && e.kind === "event")
      .map((e) => e.to),
  );
  const startedBy = sortedUnique(
    map.edges.filter((e) => e.to === agent.slug).map((e) => e.from),
  );
  if (starts.length > 0) card.starts_agents = starts;
  if (notifies.length > 0) card.emits_events_to = notifies;
  if (startedBy.length > 0) card.started_by_or_receives_events_from = startedBy;
  if (agent.triggers.some((trigger) => trigger.kind === "schedule"))
    card.runs_on_a_schedule = true;
  return {
    type: "choice",
    instructions: {
      task: "Which role best describes this agent within its project?",
      agent: card,
    },
    criteria: Object.fromEntries(ROLE_CRITERIA),
  };
}

function edgeQuestion(
  edge: MapEdge,
  bySlug: Map<string, MapAgent>,
): ChoiceQuestion {
  const endpoint = (slug: string) => ({
    name: slug,
    description: clip(bySlug.get(slug)?.description.trim() ?? "", 200),
  });
  return {
    type: "choice",
    instructions: {
      task: "How does agent A relate to agent B?",
      A: endpoint(edge.from),
      B: endpoint(edge.to),
      connection:
        edge.kind === "launch"
          ? "A's code starts B."
          : `A's code emits the event \`${edge.eventType ?? ""}\`, which triggers B.`,
      code_evidence: sortedUnique(
        edge.evidence.map((item) => clip(item.text.trim(), 160)),
      ).slice(0, 6),
    },
    criteria: Object.fromEntries(
      EDGE_CRITERIA.map(([option, rubric]) => [option, rubric]),
    ),
  };
}

function edgeSubject(edge: MapEdge): string {
  return `edge:${edge.from}>${edge.to}:${edge.kind}:${edge.eventType ?? ""}`;
}

function parseAnswer(raw: unknown, options: readonly string[]): CachedAnswer {
  const answer = raw as
    | { choice?: unknown; probabilities?: Record<string, unknown> }
    | undefined;
  const choice = answer?.choice;
  const p = answer?.probabilities?.[String(choice)];
  if (
    typeof choice !== "string" ||
    !options.includes(choice) ||
    typeof p !== "number" ||
    !Number.isFinite(p)
  ) {
    throw new Error(
      `Jev returned no usable choice: ${JSON.stringify(raw)?.slice(0, 200)}`,
    );
  }
  // Kept unrounded: the threshold compares Jev's own probability, and only the shown value rounds.
  return { value: choice, p };
}

function twoPlaces(p: number): number {
  return Math.round(p * 100) / 100;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Jev did not answer within ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Shown label for one subject: the new answer when it clears the threshold, else the one already shown. */
export function chooseShown(
  answer: CachedAnswer,
  previous: CachedAnswer | undefined,
): CachedAnswer | undefined {
  return answer.p >= LABEL_THRESHOLD ? answer : previous;
}

export async function labelMap(
  map: AgentMap,
  options: LabelOptions,
): Promise<LabelResult> {
  const stats: LabelStats = { questions: 0, asked: 0, calls: 0, costUsd: 0 };
  const unavailable = (): LabelResult => ({
    map: { ...map, labels: "unavailable" },
    stats,
  });
  if (!options.evaluate) return unavailable();

  const agents = map.agents.map((agent) => ({ ...agent }));
  const edges = map.edges.map((edge) => ({ ...edge }));
  const bySlug = new Map(agents.map((agent) => [agent.slug, agent]));
  const pending: PendingQuestion[] = [];
  for (const agent of agents) {
    if (isBoilerplate(agent)) continue;
    const question = roleQuestion(agent, map);
    pending.push({
      subject: `role:${agent.slug}`,
      key: questionKey(question),
      question,
      apply: (shown) =>
        (agent.role = {
          value: shown.value as AgentRole,
          p: twoPlaces(shown.p),
        }),
    });
  }
  for (const edge of edges) {
    if (edge.kind !== "launch" && edge.kind !== "event") continue;
    const question = edgeQuestion(edge, bySlug);
    pending.push({
      subject: edgeSubject(edge),
      key: questionKey(question),
      question,
      apply: (shown) => {
        const label = EDGE_CRITERIA.find(
          ([option]) => option === shown.value,
        )?.[2];
        if (label)
          edge.label = {
            value: label,
            p: twoPlaces(shown.p),
          } satisfies Label<EdgeLabel>;
      },
    });
  }
  stats.questions = pending.length;

  let cached: LabelCacheData;
  try {
    cached = await options.cache.read();
  } catch {
    cached = { answers: {}, shown: {} };
  }
  const answers: Record<string, CachedAnswer> = { ...cached.answers };
  const missing = new Map<string, ChoiceQuestion>();
  for (const item of pending) {
    if (!answers[item.key]) missing.set(item.key, item.question);
  }

  if (missing.size > 0) {
    const entries = [...missing.entries()];
    const chunks: Array<Array<[string, ChoiceQuestion]>> = [];
    for (let start = 0; start < entries.length; start += QUESTIONS_PER_CALL) {
      chunks.push(entries.slice(start, start + QUESTIONS_PER_CALL));
    }
    const evaluate = options.evaluate;
    try {
      const responses = await withTimeout(
        Promise.all(
          chunks.map((chunk) =>
            evaluate({
              model: LABEL_MODEL,
              state: STATE,
              questions: Object.fromEntries(chunk),
            }),
          ),
        ),
        options.timeoutMs ?? LABEL_TIMEOUT_MS,
      );
      responses.forEach((response, index) => {
        const body = response as {
          answers?: Record<string, unknown>;
          cost?: { estimateUsd?: unknown };
        } | null;
        for (const [key, question] of chunks[index]!) {
          answers[key] = parseAnswer(
            body?.answers?.[key],
            Object.keys(question.criteria),
          );
        }
        if (typeof body?.cost?.estimateUsd === "number")
          stats.costUsd += body.cost.estimateUsd;
      });
    } catch {
      return unavailable();
    }
    stats.asked = missing.size;
    stats.calls = chunks.length;
  }

  const shown: Record<string, CachedAnswer> = {};
  for (const item of pending) {
    const label = chooseShown(answers[item.key]!, cached.shown[item.subject]);
    if (!label) continue;
    shown[item.subject] = label;
    item.apply(label);
  }

  const used = new Set(pending.map((item) => item.key));
  const kept =
    Object.keys(answers).length > MAX_CACHED_ANSWERS
      ? Object.fromEntries(
          Object.entries(answers).filter(([key]) => used.has(key)),
        )
      : answers;
  const next: LabelCacheData = { answers: kept, shown };
  // Unchanged facts write nothing, so a map call never wakes a workspace watcher by itself.
  if (JSON.stringify(next) !== JSON.stringify(cached)) {
    try {
      await options.cache.write(next);
    } catch {
      // An unwritable cache costs a re-ask next time, not the labels on this map.
    }
  }
  return { map: { ...map, agents, edges, labels: "ok" }, stats };
}
