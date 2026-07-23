import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { Client } from "pg";

/**
 * Multi-Party Approval Chain (Saga) — a durable, sequential sign-off flow.
 *
 * An ordered list of approvers (e.g. legal → finance → the CEO) must each sign
 * off on a subject — a contract, a budget, a policy change — **in order**. The
 * run presents to one approver, then **suspends at $0 via `pauseUntilSignal`**
 * until that party decides; only then does it advance to the next gate. Between
 * gates it nudges the current approver (reminders) and, if they never respond,
 * escalates to a human channel (timeout). If any approver rejects, the run walks
 * a **saga compensation** — notifying everyone who already approved that the
 * chain was cancelled — instead of leaving a half-signed contract behind.
 *
 *   start → present ─(pause: approval.decision, $0 while idle)─▶ decide
 *             ▲                                                    │
 *             │ approve & more gates                              │
 *             └──────────────────────────────────────────────────┤
 *             remind ─(pause: approval.decision)──────────────────┤ reminder tick
 *             ▲                                                    │
 *             └──────────────── reminder tick (budget left) ───────┤
 *                                                                  │
 *        reject │        approve & last gate │        timeout / no-response │
 *               ▼                            ▼                              ▼
 *          compensate                    finalize                       escalate
 *          (terminal)                    (terminal)                      (terminal)
 *
 * Every gate is a durable `pauseUntilSignal`: the run survives the wait with no
 * compute burning, resuming only when a party fires `approval.decision` for this
 * run. `pauseUntilSignal` is a runtime primitive, not a metered capability — so
 * it is NOT listed in `capabilities`. The billed calls are the notifications
 * (`ctx.sapiom.email`); the optional durable audit **ledger** persists each
 * transition to a Postgres provisioned via `ctx.sapiom.database`.
 *
 * ── Reminders & timeout ────────────────────────────────────────────────────────
 * A resume with an explicit `{ decision: "approve" | "reject" }` drives the saga.
 * A resume with NO decision — the engine firing the pause `timeoutMs`, a
 * `run_local` auto-resume, or an explicit `{ decision: "remind" }` — counts as a
 * reminder tick: re-notify the current approver and re-pause, up to
 * `maxReminders`, after which the gate escalates. An explicit
 * `{ decision: "timeout" }` escalates immediately. This mirrors the "a timeout
 * fires the signal" convention — wire a cron to fire `remind`/`timeout` on a
 * schedule, or rely on the pause `timeoutMs` where the engine supports it.
 *
 * ── Chain state ────────────────────────────────────────────────────────────────
 * The canonical chain state — which gate we're on, who has approved, the full
 * transition trail — lives in `ctx.shared`, which survives every pause. When a
 * `ledgerHandle` is configured, each transition is ALSO appended to a durable
 * Postgres table (`database` capability) so the sign-off record outlives the run
 * and is queryable by the ops/legal owner. The ledger is best-effort: a missing
 * handle, a `dryRun`, or an unreachable DB degrades to `ctx.shared` + logs and
 * never fails the chain.
 *
 * Offline: `run_local` stubs the capabilities and auto-resumes each pause with no
 * payload — so the default trace walks present → reminder(s) → escalate for free
 * (no `ledgerHandle` ⇒ no live Postgres). Fire real `approval.decision` signals
 * (in dev, via the MCP `signal_workflow` / `workflow_signal` tool — see README)
 * to drive the approve → next-gate → finalize and reject → compensate paths.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** The signal a party fires to approve / reject (or nudge / time out) a gate. */
const APPROVAL_SIGNAL = "approval.decision";

/** Username for the inbox we send notifications from (created once, then reused). */
const SENDER_USERNAME = "approvals";

/** Reminders sent before a silent gate escalates. */
const DEFAULT_MAX_REMINDERS = 2;

/** Default pause timeout per gate (best-effort auto-reminder): 24 hours. */
const DEFAULT_REMINDER_MS = 24 * 60 * 60 * 1000;

/** Postgres table the durable ledger appends to. */
const LEDGER_TABLE = "approval_chain_ledger";

// ─────────────────────────────────────────────────────────────── shapes ──
/** String-only config bag (matches how templates receive their `config`). */
type Config = Record<string, string>;

/** One party in the ordered sign-off chain. */
interface Approver {
  /** Stable id used in the audit trail and compensation. */
  id: string;
  /** Human-readable name shown in notifications. */
  name: string;
  /** Where to send the sign-off request. Absent ⇒ can't be contacted (logged, skipped). */
  email?: string;
}

/** The payload a party delivers on the `approval.decision` signal. */
interface ApprovalDecision {
  /**
   * `approve` advances to the next gate (or finalizes on the last); `reject`
   * compensates; `timeout` escalates immediately; `remind` (or anything absent)
   * is a reminder tick. Safe default: only an explicit `approve` advances.
   */
  decision?: "approve" | "reject" | "timeout" | "remind";
  /** Optional free-text note carried into the trail / outcome. */
  notes?: string;
}

/** A gate a party has signed off, in order. */
interface RecordedApproval {
  id: string;
  name: string;
  notes: string | null;
}

/** One immutable row in the sign-off audit trail. */
interface Transition {
  /** Monotonic index within this run — the ledger's per-run primary key. */
  seq: number;
  /** Which gate the transition belongs to. */
  gateIndex: number;
  /** The gate's approver id, or `null` for chain-level transitions. */
  approverId: string | null;
  /** What happened: `pending` | `reminder` | `approved` | `rejected` | `timeout` | `completed` | `cancelled` | `escalated` | `chain-started`. */
  phase: string;
  /** Optional free-text detail. */
  note: string | null;
}

interface EntryInput {
  /** What is being signed off (contract, budget, policy…). */
  subject?: string;
  /** The ordered chain of approvers — each must approve before the next is asked. */
  approvers?: Approver[];
  /** Human channel to escalate to on timeout. Falls back to `config.ESCALATION_EMAIL`. */
  escalateTo?: string;
  /**
   * Handle of a durable Postgres to append the audit trail to (`database`
   * capability). Falls back to `config.LEDGER_HANDLE`. Absent ⇒ ledger kept in
   * `ctx.shared` only.
   */
  ledgerHandle?: string;
  /** Pause timeout per gate in ms (best-effort auto-reminder). Default 24h. */
  reminderMs?: number;
  /** Reminders before a silent gate escalates. Default 2. */
  maxReminders?: number;
  /** Skip the irreversible finalize action and live DB writes. `run_local` sets this. */
  dryRun?: boolean;
  /** String-only config bag (escalation / ledger fallbacks). */
  config?: Config;
}

/** State that survives the pauses, read back after each resume. */
interface Shared extends Record<string, unknown> {
  subject: string;
  approvers: Approver[];
  gateIndex: number;
  reminders: number;
  approvals: RecordedApproval[];
  trail: Transition[];
  escalateTo: string | null;
  ledgerHandle: string | null;
  reminderMs: number;
  maxReminders: number;
  dryRun: boolean;
}

type Ctx = AgentExecutionContext<Shared>;

// ─────────────────────────────────────────────────────────────── helpers ──
function must<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`missing shared state: ${name}`);
  return value;
}

/** Normalise the input chain: guarantee an id + name for every approver. */
function normalizeApprovers(raw: Approver[]): Approver[] {
  return raw.map((a, i) => ({
    id: a.id?.trim() || `approver-${i + 1}`,
    name: a.name?.trim() || a.id?.trim() || `Approver ${i + 1}`,
    email: a.email?.trim() || undefined,
  }));
}

/** Clamp a caller-supplied reminder interval to a sane positive value. */
function clampReminderMs(ms: number | undefined): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return DEFAULT_REMINDER_MS;
  }
  return Math.floor(ms);
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
 * address is an expected outcome (an approver with no email, no escalation
 * channel configured) — log and skip rather than failing the run.
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

/**
 * Append a transition to the canonical trail in `ctx.shared`, and — best-effort —
 * to the durable Postgres ledger. The ledger is an external audit copy, never the
 * source of truth: no `ledgerHandle`, a `dryRun`, or any DB error degrades to
 * `ctx.shared` + logs so an unreachable ledger can't break the sign-off flow.
 *
 * The write is keyed on `(execution_id, seq)` with `ON CONFLICT DO NOTHING`, so a
 * step retry (which re-runs the body) is idempotent.
 */
async function recordTransition(
  ctx: Ctx,
  phase: string,
  note?: string | null,
): Promise<void> {
  const approvers = ctx.shared.get("approvers") ?? [];
  const gateIndex = ctx.shared.get("gateIndex") ?? 0;
  const trail = ctx.shared.get("trail") ?? [];
  const transition: Transition = {
    seq: trail.length,
    gateIndex,
    approverId: approvers[gateIndex]?.id ?? null,
    phase,
    note: note ?? null,
  };
  ctx.shared.set("trail", [...trail, transition]);
  ctx.logger.info("ledger: transition", {
    seq: transition.seq,
    phase,
    gateIndex,
    approverId: transition.approverId,
  });

  const handle = ctx.shared.get("ledgerHandle");
  if (ctx.shared.get("dryRun") || !handle) return;
  await persistTransition(ctx, handle, transition).catch((err) => {
    // Audit persistence is best-effort; a broken ledger must not stop the chain.
    ctx.logger.warn("ledger: persist failed (kept in shared)", {
      seq: transition.seq,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/** Resolve (or provision) the ledger DB and append one transition row. */
async function persistTransition(
  ctx: Ctx,
  handle: string,
  transition: Transition,
): Promise<void> {
  const db = await ctx.sapiom.database
    .get(handle)
    .catch(() => ctx.sapiom.database.create({ duration: "7d", handle }));
  const connectionString = db.connection?.connectionString;
  if (!connectionString) {
    ctx.logger.warn("ledger: database has no connection string yet", {
      handle,
    });
    return;
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
         execution_id text NOT NULL,
         seq          integer NOT NULL,
         subject      text,
         gate_index   integer,
         approver_id  text,
         phase        text NOT NULL,
         note         text,
         recorded_at  timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (execution_id, seq)
       )`,
    );
    await client.query(
      `INSERT INTO ${LEDGER_TABLE}
         (execution_id, seq, subject, gate_index, approver_id, phase, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (execution_id, seq) DO NOTHING`,
      [
        ctx.executionId,
        transition.seq,
        ctx.shared.get("subject") ?? null,
        transition.gateIndex,
        transition.approverId,
        transition.phase,
        transition.note,
      ],
    );
  } finally {
    await client.end();
  }
}

// ─────────────────────────────────────────────────────────────── steps ──
const start = defineStep({
  name: "start",
  next: ["present", "escalate"],
  async run(input: EntryInput, ctx: Ctx) {
    const config = input.config ?? {};
    const subject = input.subject?.trim() || "(untitled approval)";
    const approvers = normalizeApprovers(input.approvers ?? []);
    ctx.shared.set("subject", subject);
    ctx.shared.set("approvers", approvers);
    ctx.shared.set("gateIndex", 0);
    ctx.shared.set("reminders", 0);
    ctx.shared.set("approvals", []);
    ctx.shared.set("trail", []);
    ctx.shared.set(
      "escalateTo",
      input.escalateTo?.trim() || config.ESCALATION_EMAIL || null,
    );
    ctx.shared.set(
      "ledgerHandle",
      input.ledgerHandle?.trim() || config.LEDGER_HANDLE || null,
    );
    ctx.shared.set("reminderMs", clampReminderMs(input.reminderMs));
    ctx.shared.set("maxReminders", input.maxReminders ?? DEFAULT_MAX_REMINDERS);
    ctx.shared.set("dryRun", input.dryRun === true);

    await recordTransition(ctx, "chain-started", subject);

    if (approvers.length === 0) {
      // Nothing to sign off — escalate rather than pausing on a gate that doesn't exist.
      ctx.logger.warn("no approvers supplied — escalating");
      return goto("escalate", { reason: "no-approvers" });
    }

    ctx.logger.info("approval chain started", {
      subject,
      gates: approvers.length,
    });
    return goto("present", {});
  },
});

const present = defineStep({
  name: "present",
  next: [],
  // Static graph edge: on the approval signal, resume at `decide`.
  pause: { signal: APPROVAL_SIGNAL, resumeStep: "decide" },
  async run(_input: unknown, ctx: Ctx) {
    const subject = must(ctx.shared.get("subject"), "subject");
    const approvers = must(ctx.shared.get("approvers"), "approvers");
    const gateIndex = must(ctx.shared.get("gateIndex"), "gateIndex");
    const reminderMs = must(ctx.shared.get("reminderMs"), "reminderMs");
    const current = approvers[gateIndex];
    if (!current) {
      // Invariant guard — callers only route here with a valid gate.
      throw new Error(
        `no approver at gate ${gateIndex} of ${approvers.length}`,
      );
    }

    // A fresh gate: reset the reminder budget and record the pending sign-off.
    ctx.shared.set("reminders", 0);
    await recordTransition(ctx, "pending");
    await notify(
      ctx,
      current.email,
      `Sign-off needed (${gateIndex + 1}/${approvers.length}): ${subject}`,
      buildRequestEmail(
        subject,
        current,
        gateIndex,
        approvers.length,
        ctx.executionId,
      ),
    );

    ctx.logger.info("presented gate; pausing for decision", {
      gate: gateIndex + 1,
      approver: current.id,
    });

    // Suspend at $0 until this party fires the approval signal for this run. The
    // `timeoutMs` is a best-effort auto-reminder where the engine supports it.
    return pauseUntilSignal({
      signal: APPROVAL_SIGNAL,
      resumeStep: "decide",
      correlationId: ctx.executionId,
      timeoutMs: reminderMs,
    });
  },
});

const decide = defineStep({
  name: "decide",
  next: ["present", "remind", "finalize", "compensate", "escalate"],
  // `payload` IS the approval signal body (or empty on a pause timeout / auto-resume).
  async run(payload: ApprovalDecision, ctx: Ctx) {
    const approvers = must(ctx.shared.get("approvers"), "approvers");
    const gateIndex = must(ctx.shared.get("gateIndex"), "gateIndex");
    const current = approvers[gateIndex];
    const decision = payload?.decision;
    ctx.logger.info("gate decision", {
      gate: gateIndex + 1,
      approver: current?.id,
      decision: decision ?? "(none)",
    });

    if (decision === "approve") {
      await recordTransition(ctx, "approved", payload?.notes);
      const approvals = ctx.shared.get("approvals") ?? [];
      ctx.shared.set("approvals", [
        ...approvals,
        {
          id: current?.id ?? `approver-${gateIndex + 1}`,
          name: current?.name ?? "(unknown)",
          notes: payload?.notes ?? null,
        },
      ]);
      const nextIndex = gateIndex + 1;
      if (nextIndex < approvers.length) {
        // Advance to the next gate in the chain.
        ctx.shared.set("gateIndex", nextIndex);
        return goto("present", {});
      }
      // Every party has signed off.
      return goto("finalize", {});
    }

    if (decision === "reject") {
      await recordTransition(ctx, "rejected", payload?.notes);
      return goto("compensate", {
        rejectedBy: current?.id ?? null,
        notes: payload?.notes ?? null,
      });
    }

    if (decision === "timeout") {
      await recordTransition(ctx, "timeout", payload?.notes);
      return goto("escalate", { reason: "timeout" });
    }

    // No explicit decision → a reminder tick (pause timeout / auto-resume / "remind").
    const reminders = (ctx.shared.get("reminders") ?? 0) + 1;
    ctx.shared.set("reminders", reminders);
    const maxReminders =
      ctx.shared.get("maxReminders") ?? DEFAULT_MAX_REMINDERS;
    if (reminders > maxReminders) {
      // Out of reminders and still no response — escalate the silent gate.
      await recordTransition(
        ctx,
        "timeout",
        `no response after ${maxReminders} reminders`,
      );
      return goto("escalate", { reason: "no-response" });
    }
    return goto("remind", {});
  },
});

const remind = defineStep({
  name: "remind",
  next: [],
  // Static graph edge: on the approval signal, resume at `decide` (same as present).
  pause: { signal: APPROVAL_SIGNAL, resumeStep: "decide" },
  async run(_input: unknown, ctx: Ctx) {
    const subject = must(ctx.shared.get("subject"), "subject");
    const approvers = must(ctx.shared.get("approvers"), "approvers");
    const gateIndex = must(ctx.shared.get("gateIndex"), "gateIndex");
    const reminderMs = must(ctx.shared.get("reminderMs"), "reminderMs");
    const reminders = ctx.shared.get("reminders") ?? 1;
    const current = approvers[gateIndex];
    if (!current) {
      throw new Error(
        `no approver at gate ${gateIndex} of ${approvers.length}`,
      );
    }

    await recordTransition(ctx, "reminder", `reminder ${reminders}`);
    await notify(
      ctx,
      current.email,
      `Reminder ${reminders}: sign-off still needed — ${subject}`,
      buildReminderEmail(subject, current, reminders, ctx.executionId),
    );

    ctx.logger.info("reminder sent; pausing again for decision", {
      gate: gateIndex + 1,
      approver: current.id,
      reminders,
    });

    // Re-suspend on the same gate until a decision (or the next reminder tick).
    return pauseUntilSignal({
      signal: APPROVAL_SIGNAL,
      resumeStep: "decide",
      correlationId: ctx.executionId,
      timeoutMs: reminderMs,
    });
  },
});

const finalize = defineStep({
  name: "finalize",
  next: [],
  terminal: true,
  async run(_input: unknown, ctx: Ctx) {
    const subject = must(ctx.shared.get("subject"), "subject");
    const approvals = ctx.shared.get("approvals") ?? [];
    const dryRun = ctx.shared.get("dryRun") ?? false;

    await recordTransition(ctx, "completed");

    if (dryRun) {
      // Offline / preview: the single irreversible action is a no-op. Every gate,
      // notification, and ledger row up to here already ran (or was traced) for real.
      ctx.logger.info("dry run: skipping the irreversible finalize action", {
        subject,
        approvals: approvals.length,
      });
      return terminate({
        committed: false,
        dryRun: true,
        outcome: "dry-run",
        subject,
        approvals,
      });
    }

    // ── The single irreversible action ─────────────────────────────────────
    // Reached ONLY after EVERY party in the chain approved. In a real fork,
    // replace this completion notice with the action the sign-off authorises —
    // countersign + release the contract, disburse the budget, publish the policy.
    let notified = 0;
    for (const approver of ctx.shared.get("approvers") ?? []) {
      const email = approver.email;
      if (
        await notify(
          ctx,
          email,
          `Approved & finalised: ${subject}`,
          buildCompletedEmail(subject, approvals, ctx.executionId),
        )
      ) {
        notified += 1;
      }
    }

    ctx.logger.info("chain finalised", {
      subject,
      approvals: approvals.length,
    });
    return terminate({
      committed: true,
      dryRun: false,
      outcome: "completed",
      subject,
      approvals,
      notified,
    });
  },
});

const compensate = defineStep({
  name: "compensate",
  next: [],
  terminal: true,
  async run(
    input: { rejectedBy?: string | null; notes?: string | null },
    ctx: Ctx,
  ) {
    const subject = must(ctx.shared.get("subject"), "subject");
    const approvals = ctx.shared.get("approvals") ?? [];
    const approvers = ctx.shared.get("approvers") ?? [];
    const rejectedBy = input?.rejectedBy ?? null;

    await recordTransition(ctx, "cancelled", input?.notes);

    // Saga compensation: everyone who already approved acted on the assumption
    // the chain would complete. Notify them it was cancelled so downstream
    // effects of their sign-off can be unwound. Nothing irreversible ran, so the
    // compensation is a set of notifications, not a rollback of committed work.
    let compensated = 0;
    for (const approved of approvals) {
      const contact = approvers.find((a) => a.id === approved.id)?.email;
      if (
        await notify(
          ctx,
          contact,
          `Cancelled: ${subject}`,
          buildCancelledEmail(subject, approved, rejectedBy),
        )
      ) {
        compensated += 1;
      }
    }

    ctx.logger.info("chain rejected — compensated prior approvals", {
      subject,
      rejectedBy,
      compensated,
    });
    return terminate({
      committed: false,
      outcome: "rejected",
      subject,
      rejectedBy,
      approved: approvals,
      compensated,
    });
  },
});

const escalate = defineStep({
  name: "escalate",
  next: [],
  terminal: true,
  async run(input: { reason?: string }, ctx: Ctx) {
    const subject = must(ctx.shared.get("subject"), "subject");
    const approvers = ctx.shared.get("approvers") ?? [];
    const gateIndex = ctx.shared.get("gateIndex") ?? 0;
    const escalateTo = ctx.shared.get("escalateTo") ?? null;
    const reason = input?.reason ?? "no-response";
    const stalledAt = approvers[gateIndex] ?? null;

    await recordTransition(ctx, "escalated", reason);
    await notify(
      ctx,
      escalateTo,
      `Escalation: approval chain stalled — ${subject}`,
      buildEscalationEmail(subject, stalledAt, gateIndex, reason),
    );

    ctx.logger.info("escalated to human channel", {
      subject,
      escalateTo,
      reason,
      gate: gateIndex + 1,
    });
    return terminate({
      committed: false,
      outcome: "escalated",
      reason,
      subject,
      stalledAtGate: approvers.length > 0 ? gateIndex + 1 : 0,
      stalledApprover: stalledAt
        ? { id: stalledAt.id, name: stalledAt.name }
        : null,
    });
  },
});

// ─────────────────────────────────────────────────────── email bodies ──
function buildRequestEmail(
  subject: string,
  approver: Approver,
  gateIndex: number,
  total: number,
  executionId: string,
): string {
  return [
    `Hi ${approver.name},`,
    "",
    `Your sign-off is needed on: ${subject}`,
    `You are approver ${gateIndex + 1} of ${total} in the chain.`,
    "",
    "Fire the `approval.decision` signal with",
    '{"decision":"approve"} to sign off, or {"decision":"reject"} to stop the chain.',
    `Run: ${executionId}`,
  ].join("\n");
}

function buildReminderEmail(
  subject: string,
  approver: Approver,
  reminders: number,
  executionId: string,
): string {
  return [
    `Hi ${approver.name},`,
    "",
    `Reminder #${reminders}: we're still waiting on your sign-off for: ${subject}`,
    "",
    "Fire the `approval.decision` signal with",
    '{"decision":"approve"} or {"decision":"reject"}. If we don\'t hear back,',
    "the request will be escalated.",
    `Run: ${executionId}`,
  ].join("\n");
}

function buildCompletedEmail(
  subject: string,
  approvals: RecordedApproval[],
  executionId: string,
): string {
  return [
    `The approval chain for "${subject}" is complete — every party signed off.`,
    "",
    "Sign-off order:",
    ...approvals.map((a, i) => `${i + 1}. ${a.name}`),
    "",
    `Run: ${executionId}`,
  ].join("\n");
}

function buildCancelledEmail(
  subject: string,
  approved: RecordedApproval,
  rejectedBy: string | null,
): string {
  return [
    `Hi ${approved.name},`,
    "",
    `The approval chain for "${subject}" was cancelled${
      rejectedBy ? ` (rejected by ${rejectedBy})` : ""
    }.`,
    "You approved an earlier gate — no further action is needed, and any",
    "downstream effect of your sign-off should be treated as void.",
  ].join("\n");
}

function buildEscalationEmail(
  subject: string,
  stalledAt: Approver | null,
  gateIndex: number,
  reason: string,
): string {
  return [
    `Escalation: the approval chain for "${subject}" stalled.`,
    "",
    `Reason: ${reason}.`,
    stalledAt
      ? `Waiting on gate ${gateIndex + 1}: ${stalledAt.name} (${stalledAt.id}).`
      : "No approvers were supplied to the chain.",
    "",
    "Human intervention needed to unblock or cancel the sign-off.",
  ].join("\n");
}

export const agent = defineAgent<EntryInput, Shared>({
  name: "approval-chain",
  entry: "start",
  steps: {
    start,
    present,
    decide,
    remind,
    finalize,
    compensate,
    escalate,
  },
});
