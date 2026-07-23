import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";

/**
 * Human-in-the-Loop Approval — the "ask before you commit/spend" pattern.
 *
 * Do the reversible work first (parse the request, rank the candidates by fit,
 * notify the approver), then **block on a human approval signal** before anything
 * irreversible or billed happens. On approve, run a **ranked sequential-fallback
 * loop**: make a provisional offer to the top candidate, wait for their confirm,
 * and advance to the next on decline/timeout — committing the single irreversible
 * action only when a candidate accepts, and escalating to a human if the ranked
 * list is exhausted.
 *
 *   parse → rank → notifyApprover ─(pause: approval.decision, $0 while idle)─▶ onDecision
 *                                                                                │
 *                          reject ◀──────────────────────────────────────────────┼─▶ approve
 *                            │                                                     ▼
 *                          revert (terminal)                     offer ─(pause: candidate.confirm)─▶ resolve
 *                                                                  ▲                                    │
 *                                        decline/timeout & more ───┘        accept │ exhausted │        │
 *                                                                                  ▼           ▼
 *                                                                             commit       escalate
 *                                                                            (terminal)    (terminal)
 *
 * Two durable pauses (`pauseUntilSignal`) suspend the run at $0: the approval
 * gate, and each turn of the confirmation loop. `pauseUntilSignal` is a runtime
 * primitive, not a metered capability. The billed calls are the model reasoning
 * (`ctx.sapiom.models.run` — the live x402 path; `ctx.sapiom.llm` does NOT exist)
 * and the notifications (`ctx.sapiom.email`).
 *
 * Offline: `run_local` stubs the capabilities and auto-resumes the pauses. A
 * resume with no explicit decision takes the SAFE branch (nothing commits), and
 * the `dryRun` guard makes `commit`'s irreversible action a no-op — so the whole
 * graph traces end to end for free. Fire real `approval.decision` / `candidate.confirm`
 * signals (in dev, via the MCP `workflow_signal` tool — see README) to drive the
 * approve → accept → commit path and the fallback loop.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** How many top-ranked candidates to describe in the approver notification. */
const APPROVER_PREVIEW = 5;

/** The signal a human fires to approve or reject the recommendation. */
const APPROVAL_SIGNAL = "approval.decision";
/** The signal a candidate fires to accept or decline a provisional offer. */
const CONFIRM_SIGNAL = "candidate.confirm";

/** Username for the inbox we send notifications from (created once, then reused). */
const SENDER_USERNAME = "approvals";

// ─────────────────────────────────────────────────────────────── shapes ──
/** String-only config bag (matches how templates receive their `config`). */
type Config = Record<string, string>;

/** A candidate the request could be fulfilled by, in any order. */
interface Candidate {
  /** Stable id, echoed back by the ranking model to preserve contact info. */
  id: string;
  /** Human-readable name shown in notifications. */
  name: string;
  /** Where to send the provisional offer / result. Absent ⇒ can't be contacted. */
  email?: string;
  /** Freeform attributes the ranking model can weigh (fit, price, availability…). */
  attributes?: Record<string, unknown>;
}

/** A candidate plus the model's fit assessment. */
interface RankedCandidate extends Candidate {
  /** Fit score the model assigned (higher = better fit), for display/ordering. */
  score: number;
  /** Why the model ranked it here. */
  rationale: string;
}

/** Structured intent extracted from the free-text request. */
interface ParsedRequest {
  /** One-line summary of what's being requested. */
  summary: string;
  /** Criteria the ranking should optimise for (fit, not just cost). */
  criteria: string[];
}

interface EntryInput {
  /** The natural-language request to fulfil (parsed by the model). */
  request: string;
  /** The pool of candidates to rank and offer to, in any order. */
  candidates: Candidate[];
  /** Who approves before anything commits. Falls back to `config.APPROVER_EMAIL`. */
  approver?: string;
  /** Human channel to escalate to when the ranked list is exhausted. Falls back to `config.ESCALATION_EMAIL`. */
  escalateTo?: string;
  /** Compute + notify but never perform the irreversible commit. `run_local` sets this. */
  dryRun?: boolean;
  /** String-only config bag (approver / escalation fallbacks). */
  config?: Config;
}

/** The payload the human delivers on the `approval.decision` signal. */
interface ApprovalDecision {
  /** `approve` proceeds; anything else (or absent) takes the safe reject branch. */
  decision?: "approve" | "reject";
  /** Optional free-text rationale carried through to the outcome. */
  notes?: string;
}

/** The payload a candidate delivers on the `candidate.confirm` signal. */
interface ConfirmDecision {
  /** `accept` commits; `decline`/`timeout` (or absent) advance to the next candidate. */
  decision?: "accept" | "decline" | "timeout";
  /** Optional free-text note carried through to the outcome. */
  notes?: string;
}

/** State that survives the pauses, read back after each resume. */
interface Shared extends Record<string, unknown> {
  request: string;
  parsed: ParsedRequest;
  ranked: RankedCandidate[];
  index: number;
  approver: string | null;
  escalateTo: string | null;
  dryRun: boolean;
}

type Ctx = AgentExecutionContext<Shared>;

// ─────────────────────────────────────────────────────────────── helpers ──
function must<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`missing shared state: ${name}`);
  return value;
}

/** Reuse an existing inbox to send from, else provision one. */
async function resolveSenderInbox(ctx: Ctx): Promise<string> {
  const existing = await ctx.sapiom.email.inboxes.list({ limit: 1 });
  if (existing.inboxes.length > 0) return existing.inboxes[0].inboxId;
  const inbox = await ctx.sapiom.email.inboxes.create({
    username: SENDER_USERNAME,
    displayName: "Approvals",
  });
  return inbox.inboxId;
}

/**
 * Send a notification, degrading gracefully when there's no recipient. A missing
 * address is an expected outcome (a candidate with no email, no approver
 * configured yet) — log and skip rather than failing the run.
 */
async function notify(
  ctx: Ctx,
  to: string | null | undefined,
  subject: string,
  text: string,
): Promise<boolean> {
  if (!to) {
    ctx.logger.warn("notify skipped: no recipient", { subject });
    return false;
  }
  const inboxId = await resolveSenderInbox(ctx);
  const sent = await ctx.sapiom.email.messages.send(inboxId, {
    to,
    subject,
    text,
  });
  ctx.logger.info("notified", { to, subject, messageId: sent.messageId });
  return true;
}

// ─────────────────────────────────────────────────────── model reasoning ──
/** Parse the free-text request into structured intent (reversible prep). */
async function parseRequest(ctx: Ctx, request: string): Promise<ParsedRequest> {
  if (!request) return { summary: "(empty request)", criteria: [] };
  const system =
    "You extract structured intent from a request that will be fulfilled by " +
    "selecting one of several candidates. Identify what is being asked for and " +
    "the criteria that should drive the choice (weigh fit, not just cost). " +
    'Reply with ONLY minified JSON: {"summary":string,"criteria":string[]}.';
  const res = await ctx.sapiom.models.run({
    prompt: request,
    system,
    maxTokens: 300,
  });
  return coerceParsed(res.output, request);
}

/**
 * Rank the candidates by fit to the parsed criteria. Every input candidate is
 * returned exactly once (contact info preserved); the model only reorders + scores.
 */
async function rankCandidates(
  ctx: Ctx,
  parsed: ParsedRequest,
  candidates: Candidate[],
): Promise<RankedCandidate[]> {
  if (candidates.length === 0) return [];
  const system =
    "You rank candidates by how well they FIT the criteria — not by cost alone. " +
    "Return every candidate exactly once, best first, each with a 0-100 fit " +
    "score and a one-line rationale. Use the candidate `id` values verbatim. " +
    'Reply with ONLY minified JSON: {"ranking":[{"id":string,"score":number,"rationale":string}]}.';
  const prompt =
    `CRITERIA:\n${parsed.criteria.map((c) => `- ${c}`).join("\n") || "- (none)"}\n\n` +
    `CANDIDATES:\n${JSON.stringify(candidates)}`;
  const res = await ctx.sapiom.models.run({ prompt, system, maxTokens: 600 });
  return applyRanking(res.output, candidates);
}

// ─────────────────────────────────────────────────────────────── steps ──
const parse = defineStep({
  name: "parse",
  next: ["rank"],
  async run(input: EntryInput, ctx: Ctx) {
    const request = input.request?.trim() ?? "";
    const config = input.config ?? {};
    ctx.shared.set("request", request);
    ctx.shared.set("index", 0);
    ctx.shared.set(
      "approver",
      input.approver?.trim() || config.APPROVER_EMAIL || null,
    );
    ctx.shared.set(
      "escalateTo",
      input.escalateTo?.trim() || config.ESCALATION_EMAIL || null,
    );
    ctx.shared.set("dryRun", input.dryRun === true);

    // Reversible prep: understand the request before touching any candidate.
    const parsed = await parseRequest(ctx, request);
    ctx.shared.set("parsed", parsed);
    ctx.logger.info("parsed request", {
      summary: parsed.summary,
      criteria: parsed.criteria.length,
    });
    return goto("rank", { candidates: input.candidates ?? [] });
  },
});

const rank = defineStep({
  name: "rank",
  next: ["notifyApprover"],
  async run(input: { candidates: Candidate[] }, ctx: Ctx) {
    const parsed = must(ctx.shared.get("parsed"), "parsed");
    const ranked = await rankCandidates(ctx, parsed, input.candidates ?? []);
    ctx.shared.set("ranked", ranked);
    ctx.logger.info("ranked candidates", {
      count: ranked.length,
      top: ranked[0]?.id ?? null,
    });
    return goto("notifyApprover", {});
  },
});

const notifyApprover = defineStep({
  name: "notifyApprover",
  next: [],
  // Static graph edge: on the approval signal, resume at `onDecision`. Must match
  // the `pauseUntilSignal` directive below.
  pause: { signal: APPROVAL_SIGNAL, resumeStep: "onDecision" },
  async run(_input: unknown, ctx: Ctx) {
    const parsed = must(ctx.shared.get("parsed"), "parsed");
    const ranked = must(ctx.shared.get("ranked"), "ranked");
    const approver = ctx.shared.get("approver") ?? null;

    // Reversible prep: notify the approver with the ranked recommendation.
    await notify(
      ctx,
      approver,
      `Approval needed: ${parsed.summary}`,
      buildApproverEmail(parsed, ranked, ctx.executionId),
    );

    ctx.logger.info("approver notified; pausing for decision", {
      approver,
      ranked: ranked.length,
    });

    // Suspend at $0 until a human fires the approval signal for this run.
    return pauseUntilSignal({
      signal: APPROVAL_SIGNAL,
      resumeStep: "onDecision",
      correlationId: ctx.executionId,
    });
  },
});

const onDecision = defineStep({
  name: "onDecision",
  next: ["offer", "escalate", "revert"],
  // `payload` IS the approval signal body.
  async run(payload: ApprovalDecision, ctx: Ctx) {
    const ranked = must(ctx.shared.get("ranked"), "ranked");
    // Safe default: only an explicit `approve` proceeds — the whole point of the
    // gate is that nothing commits without a deliberate human yes.
    const approved = payload?.decision === "approve";
    ctx.logger.info("approval decision", {
      decision: payload?.decision ?? "(none)",
      approved,
    });
    if (!approved) return goto("revert", { notes: payload?.notes });
    // Approved but nobody to offer to → escalate rather than pause forever.
    if (ranked.length === 0)
      return goto("escalate", { reason: "no-candidates" });
    return goto("offer", {});
  },
});

const revert = defineStep({
  name: "revert",
  next: [],
  terminal: true,
  async run(input: { notes?: string }, ctx: Ctx) {
    // Nothing irreversible happened before the approval gate, so reverting to a
    // safe state is a clean no-op: log the rejection and terminate.
    ctx.logger.info("rejected — reverting to safe state, nothing committed");
    return terminate({
      committed: false,
      outcome: "rejected",
      notes: input?.notes ?? null,
    });
  },
});

const offer = defineStep({
  name: "offer",
  next: [],
  // Static graph edge: on a candidate's confirm, resume at `resolve`.
  pause: { signal: CONFIRM_SIGNAL, resumeStep: "resolve" },
  async run(_input: unknown, ctx: Ctx) {
    const ranked = must(ctx.shared.get("ranked"), "ranked");
    const index = must(ctx.shared.get("index"), "index");
    const candidate = ranked[index];
    if (!candidate) {
      // Invariant guard — callers only route here with a valid index.
      throw new Error(`no candidate at index ${index} of ${ranked.length}`);
    }

    // Provisional, NON-committing offer to the current top-ranked candidate.
    await notify(
      ctx,
      candidate.email,
      `Provisional offer (please confirm)`,
      buildOfferEmail(candidate, index, ctx.executionId),
    );

    ctx.logger.info("provisional offer sent; pausing for confirm", {
      candidate: candidate.id,
      index,
    });

    // Suspend at $0 until this candidate confirms (or a timeout fires the signal).
    return pauseUntilSignal({
      signal: CONFIRM_SIGNAL,
      resumeStep: "resolve",
      correlationId: ctx.executionId,
    });
  },
});

const resolve = defineStep({
  name: "resolve",
  next: ["commit", "offer", "escalate"],
  // `payload` IS the candidate confirm signal body.
  async run(payload: ConfirmDecision, ctx: Ctx) {
    const ranked = must(ctx.shared.get("ranked"), "ranked");
    const index = must(ctx.shared.get("index"), "index");
    // Safe default: only an explicit `accept` commits.
    const accepted = payload?.decision === "accept";
    ctx.logger.info("candidate confirm", {
      decision: payload?.decision ?? "(none)",
      index,
      accepted,
    });
    if (accepted) return goto("commit", {});

    // decline / timeout / anything else → advance to the next ranked candidate.
    const nextIndex = index + 1;
    ctx.shared.set("index", nextIndex);
    if (nextIndex < ranked.length) return goto("offer", {});
    // Ranked list exhausted — escalate instead of silently failing.
    return goto("escalate", { reason: "exhausted" });
  },
});

const commit = defineStep({
  name: "commit",
  next: [],
  terminal: true,
  async run(_input: unknown, ctx: Ctx) {
    const ranked = must(ctx.shared.get("ranked"), "ranked");
    const index = must(ctx.shared.get("index"), "index");
    const dryRun = ctx.shared.get("dryRun") ?? true;
    const selected = ranked[index];
    const others = ranked.filter((_, i) => i !== index);
    const selectedRef = selected
      ? { id: selected.id, name: selected.name }
      : null;

    if (dryRun) {
      // Offline / preview: the single irreversible action is a no-op. Everything
      // up to here (parse, rank, notify, provisional offer) already ran for real.
      ctx.logger.info("dry run: skipping the irreversible commit", {
        selected: selected?.id,
      });
      return terminate({
        committed: false,
        dryRun: true,
        outcome: "dry-run",
        selected: selectedRef,
      });
    }

    // ── The single irreversible / expensive action ─────────────────────────
    // Reached ONLY after a human approved AND a candidate accepted. In a real
    // fork, replace this binding confirmation with your irreversible action —
    // charge a card, book a resource, sign a contract, provision infra.
    await notify(
      ctx,
      selected?.email,
      `Confirmed — you're selected`,
      buildCommitEmail(selected, ctx.executionId),
    );
    // Courtesy notification to the candidates who weren't selected (reversible).
    let notified = 0;
    for (const other of others) {
      if (
        await notify(
          ctx,
          other.email,
          `Update on your offer`,
          buildNotSelectedEmail(other),
        )
      )
        notified += 1;
    }

    ctx.logger.info("committed", { selected: selected?.id, notified });
    return terminate({
      committed: true,
      dryRun: false,
      outcome: "committed",
      selected: selectedRef,
      notified,
    });
  },
});

const escalate = defineStep({
  name: "escalate",
  next: [],
  terminal: true,
  async run(input: { reason?: string }, ctx: Ctx) {
    const parsed = must(ctx.shared.get("parsed"), "parsed");
    const ranked = must(ctx.shared.get("ranked"), "ranked");
    const escalateTo = ctx.shared.get("escalateTo") ?? null;
    const reason = input?.reason ?? "exhausted";

    await notify(
      ctx,
      escalateTo,
      `Escalation: no candidate accepted`,
      buildEscalationEmail(parsed, ranked, reason),
    );

    ctx.logger.info("escalated to human channel", { escalateTo, reason });
    return terminate({
      committed: false,
      outcome: "escalated",
      reason,
      considered: ranked.length,
    });
  },
});

// ─────────────────────────────────────────────────────── email bodies ──
function buildApproverEmail(
  parsed: ParsedRequest,
  ranked: RankedCandidate[],
  executionId: string,
): string {
  const list =
    ranked.length > 0
      ? ranked
          .slice(0, APPROVER_PREVIEW)
          .map(
            (c, i) => `${i + 1}. ${c.name} (score ${c.score}) — ${c.rationale}`,
          )
          .join("\n")
      : "(no candidates supplied)";
  return [
    `Approval requested for: ${parsed.summary}`,
    "",
    "Criteria:",
    ...(parsed.criteria.length > 0
      ? parsed.criteria.map((c) => `- ${c}`)
      : ["- (none)"]),
    "",
    `Recommended order (top ${Math.min(APPROVER_PREVIEW, ranked.length)}):`,
    list,
    "",
    "Nothing has been committed. Fire the `approval.decision` signal with",
    '{"decision":"approve"} to proceed, or {"decision":"reject"} to stop.',
    `Run: ${executionId}`,
  ].join("\n");
}

function buildOfferEmail(
  candidate: RankedCandidate,
  index: number,
  executionId: string,
): string {
  return [
    `Hi ${candidate.name},`,
    "",
    "You're our top pick (this offer is provisional and not yet binding).",
    `Rank: #${index + 1} — ${candidate.rationale}`,
    "",
    "Confirm by firing the `candidate.confirm` signal with",
    '{"decision":"accept"} to accept, or {"decision":"decline"} to pass.',
    `Run: ${executionId}`,
  ].join("\n");
}

function buildCommitEmail(
  candidate: RankedCandidate | undefined,
  executionId: string,
): string {
  return [
    `Hi ${candidate?.name ?? "there"},`,
    "",
    "This confirms you've been selected — the commitment is now final.",
    `Run: ${executionId}`,
  ].join("\n");
}

function buildNotSelectedEmail(candidate: RankedCandidate): string {
  return [
    `Hi ${candidate.name},`,
    "",
    "Thanks for your interest — another candidate was selected this time.",
  ].join("\n");
}

function buildEscalationEmail(
  parsed: ParsedRequest,
  ranked: RankedCandidate[],
  reason: string,
): string {
  return [
    `Escalation: could not fulfil "${parsed.summary}" automatically.`,
    "",
    `Reason: ${reason}.`,
    `Candidates considered: ${ranked.length}.`,
    "",
    reason === "exhausted"
      ? "Every ranked candidate declined or timed out. Human intervention needed."
      : "No candidates were available to offer to. Human intervention needed.",
  ].join("\n");
}

// ─────────────────────────────────────────────────────── output parsing ──
/** Coerce the parse-step model output into a `ParsedRequest`, with a fallback. */
function coerceParsed(output: string | null, request: string): ParsedRequest {
  const fallback: ParsedRequest = {
    summary: request.slice(0, 120) || "(empty request)",
    criteria: [],
  };
  const obj = extractJson(output);
  if (!obj) return fallback;
  const summary =
    typeof obj.summary === "string" && obj.summary.trim()
      ? obj.summary.trim()
      : fallback.summary;
  const criteria = Array.isArray(obj.criteria)
    ? obj.criteria.filter((c): c is string => typeof c === "string")
    : [];
  return { summary, criteria };
}

/**
 * Apply the ranking-model output to the candidate pool: reorder by the model's
 * ranking, attach score + rationale, and guarantee every candidate appears
 * exactly once (falling back to input order for anything the model dropped).
 */
function applyRanking(
  output: string | null,
  candidates: Candidate[],
): RankedCandidate[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const obj = extractJson(output);
  const rawRanking = obj && Array.isArray(obj.ranking) ? obj.ranking : [];

  const ranked: RankedCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of rawRanking) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : undefined;
    if (!id || seen.has(id)) continue;
    const candidate = byId.get(id);
    if (!candidate) continue;
    seen.add(id);
    ranked.push({
      ...candidate,
      score: typeof e.score === "number" ? e.score : 0,
      rationale:
        typeof e.rationale === "string" ? e.rationale : "(no rationale)",
    });
  }

  // Append any candidate the model omitted, preserving input order.
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    ranked.push({ ...candidate, score: 0, rationale: "(unranked)" });
  }
  return ranked;
}

/** Best-effort extraction of a single JSON object from model output. */
function extractJson(output: string | null): Record<string, unknown> | null {
  if (!output) return null;
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < 0 || end < start) return null;
  try {
    return JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const agent = defineAgent<EntryInput, Shared>({
  name: "human-in-the-loop",
  entry: "parse",
  steps: {
    parse,
    rank,
    notifyApprover,
    onDecision,
    revert,
    offer,
    resolve,
    commit,
    escalate,
  },
});
