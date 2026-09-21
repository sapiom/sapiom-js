/**
 * The creation entry's two pieces of pure logic (flow-creation.md §4.4, §4.6;
 * design-eng D30, D31, and the mock's `lib/creation-entry.ts`, which this
 * mirrors so the harness refuses the same ideas the design does).
 *
 * 1. THE AGENT'S NAME. The new-agent screen has ONE field, the idea, so the
 *    name is derived from it: the first two content words, kebab-cased. The
 *    server is the judge (`POST /api/agents/scaffold` refuses a duplicate or
 *    an invalid name), and its refusal lands under the field.
 *
 * 2. THE PLANNING INSTRUCTIONS. The session that opens is the ORDINARY one,
 *    with the ordinary system prompt; never a planner or planning-mode type.
 *    The instructions ride the first prompt as session setup, after the idea
 *    and the resources, and tell the agent to plan before it builds. Nothing
 *    here asks the agent to scaffold: the harness already did that.
 */
import type { StudioTemplate } from "./templates";

export const AGENT_AUTHORING_SKILL = "sapiom-agent-authoring";

/** Function words and the verbs an idea is phrased with. Neither names an agent. */
const NOISE = new Set([
  "a", "an", "the", "my", "our", "your", "their", "its", "this", "that", "these", "those",
  "and", "or", "but", "then", "so", "to", "for", "of", "in", "on", "at", "by", "with",
  "from", "into", "onto", "about", "as", "is", "are", "be", "it", "them", "me", "us", "we",
  "i", "you", "he", "she", "they", "who", "which", "what", "when", "where", "how", "every",
  "each", "all", "any", "some", "new", "first", "one", "per", "up", "out", "over",
  "agent", "agents", "workflow", "bot", "assistant", "automation",
  "build", "builds", "create", "creates", "make", "makes", "want", "wants", "need", "needs",
  "should", "would", "could", "can", "will", "please", "help", "let", "lets",
  "watch", "watches", "send", "sends", "draft", "drafts", "triage", "triages", "find", "finds",
  "write", "writes", "verify", "verifies", "follow", "follows", "review", "reviews",
  "check", "checks", "read", "reads", "post", "posts", "track", "tracks", "monitor", "monitors",
  "summarize", "summarizes", "summarise", "summarises", "generate", "generates", "run", "runs",
  "use", "uses", "get", "gets", "pull", "pulls", "scan", "scans", "look", "looks", "keep", "keeps",
  "take", "takes", "give", "gives", "turn", "turns", "answer", "answers", "reply", "replies",
  "until", "someone", "something", "everything", "start", "template",
]);

/**
 * "Build an agent that watches my competitors and sends a sourced digest
 * every Monday." -> "competitors-digest". Adjectives in -ed ("sourced",
 * "personalized") are dropped too. Returns "" when nothing usable is left,
 * which the server refuses as an invalid name ("Give the agent a name.").
 */
export function deriveAgentName(idea: string): string {
  const words = idea
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !NOISE.has(word) && !/ed$/.test(word));
  return words.slice(0, 2).join("-");
}

/** How the screen phrases a template chosen as the starting point: the
 *  template IS the idea, editable before send (CF-D11). */
export function templateIdea(template: StudioTemplate): string {
  return `Start from the ${template.name} template. ${template.description}`.trim();
}

export interface PlanningContext {
  /** The agent the harness already scaffolded, named so the instructions say
   *  the scaffold is DONE rather than ask for one. */
  agentName: string;
  /** The project the agent was created in, as the rail labels it. */
  projectLabel: string;
  /** The template the user started from, if any. A starter was scaffolded
   *  already; a gallery template is brought in at build time. */
  template?: StudioTemplate | null;
}

/**
 * The planning instructions (flow-creation.md §4.6 step 2), in order. Sent as
 * session setup with the first prompt, never as the user's words. Plain
 * declaratives in the agent's own register (VOICE): no throat-clearing, one
 * question at a time with its default, nothing called built before it is
 * checked.
 */
export function planningInstructions({
  agentName,
  projectLabel,
  template,
}: PlanningContext): string {
  const origin =
    template?.kind === "starter"
      ? ` It was scaffolded from the ${template.name} starter.`
      : template?.kind === "gallery"
        ? ` I chose the gallery template ${template.id} as the starting point: at build time, bring it in with the sapiom_dev_agents_clone tool (templateId "${template.id}") into a scratch folder beside this agent and port what fits.`
        : "";
  // The wording is the design's (design-eng agent-studio-v2
  // `lib/creation-entry.ts`, D37), so the disclosure in the pane reads the
  // same seven moves the mock shows. Step 1 reads the Agent Map; nothing here
  // writes it (Q11).
  return [
    `${agentName} is already scaffolded in ${projectLabel}; do not scaffold it again.${origin} Plan before you build, in this order:`,
    "1. Read every attached source and the existing project: its agents, its Agent Map, its secrets by name.",
    "2. Restate the outcome and the proof of success in two lines.",
    "3. Ask at most three clarifying questions, each with the default you will take if unanswered, and stop for the answer. Ask only where the answer changes the agent. If the idea and the sources already answer everything, ask nothing and say so.",
    "4. When the idea falls short of what a design needs, offer three framings of the agent before asking anything, and let the user pick or edit one.",
    "5. Propose the shape in the conversation, short and structured: steps, capabilities needed, resources missing, schedule if any.",
    "6. Build only after the user says go or accepts the defaults.",
    `7. Use the ${AGENT_AUTHORING_SKILL} skill; run check and run_local before calling anything built.`,
  ].join("\n");
}

/** What the workbench says the session was set up with. */
export const SETUP_CARD = {
  title: "Planning instructions",
  summary: "Session setup, sent with your idea",
} as const;
