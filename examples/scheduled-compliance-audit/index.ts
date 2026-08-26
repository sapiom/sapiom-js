import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { z } from "zod/v4";

/**
 * Scheduled Compliance Audit + Attestation — the recurring "prove we're still
 * compliant" pattern.
 *
 * On each tick it collects the current state of the resources you point it at
 * (config pages, status endpoints, policy docs — read with `web.scrape`), asks
 * an LLM (`ctx.sapiom.llm.run` — the live x402 path) to check that state
 * against your `policy` and produce a structured finding, then **pauses for a
 * human sign-off**. Only after a person explicitly approves does it archive the
 * signed attestation as a durable file (`fileStorage.upload`) — because an
 * attestation is a record that a human reviewed and signed off, auto-archiving
 * one without a real sign-off would be a lie.
 *
 *   collect (web.scrape) → audit (llm.run) ─(pause: attestation.signoff, $0)─▶ onSignoff
 *                                                                                    │
 *                                              reject ◀───────────────────────────────┼─▶ approve
 *                                                │                                     ▼
 *                                            rejected (terminal)                  archive (fileStorage, terminal)
 *
 * The durable pause (`pauseUntilSignal`) suspends the run at $0 until a person
 * fires the sign-off signal — it is a runtime primitive, not a metered
 * capability. The billed calls are the scrapes (`web.scrape`), the model
 * reasoning (`ctx.sapiom.llm.run`), and the
 * attestation upload (`fileStorage.upload`).
 *
 * Side-effect discipline (copied from `scheduled-research-brief` /
 * `human-in-the-loop`):
 *   - `dryRun` gates the one irreversible action: `archive` computes the
 *     attestation and returns it as a preview WITHOUT uploading anything. The
 *     upload's presigned PUT is a raw `fetch` (not a stubbed capability), so it
 *     must stay behind this guard or it would hit the network offline.
 *   - A resume with no explicit `approve` takes the SAFE branch (`rejected`,
 *     nothing archived). `run_local` auto-resumes the pause, so the offline trace
 *     lands on `rejected` by default; fire a real `attestation.signoff` signal
 *     with `{ "decision": "approve" }` to drive the archive path (see README).
 *   - The scraped bodies are the only large data; they stay bounded (truncated,
 *     capped count) and die at the `audit` boundary — they never enter
 *     `ctx.shared` (large shared state stalls transitions on the cloud engine).
 */

// ─────────────────────────────────────────────────────────────── config ──
/** Default cadence when the caller doesn't pass one: 06:00 every Monday. */
const DEFAULT_SCHEDULE = "0 6 * * 1";
/** Cap on how many resources we scrape per run (keeps latency + cost bounded). */
const MAX_RESOURCES = 8;
/** Truncate each scraped body — the ONLY large data on the collect→audit path. */
const MAX_BODY_CHARS = 2000;
/** The signal a human fires to approve or reject the attestation. */
const SIGNOFF_SIGNAL = "attestation.signoff";

// ─────────────────────────────────────────────────────────────── shapes ──
/** A resource whose current state should be audited against the policy. */
interface ResourceRef {
  /** Stable id echoed into findings so a check maps back to its resource. */
  id: string;
  /** Where to read the resource's current config/state from. */
  url: string;
  /** Human-readable label shown in the attestation. Falls back to `id`. */
  label?: string;
}

interface EntryInput {
  /** The resources/config to collect and audit on each tick. */
  resources: ResourceRef[];
  /** The policy the collected state is checked against (free text or rules). */
  policy: string;
  /** Cron cadence this audit is meant to run on (e.g. "0 6 * * 1"). */
  schedule?: string;
  /** Compliance framework label for the attestation title (e.g. "SOC 2 CC6"). */
  framework?: string;
  /** Who is expected to sign off; recorded in the attestation. Informational. */
  signOffBy?: string;
  /**
   * Compute + pause but never perform the real archive upload. Nothing sets this
   * for you — pass it explicitly when you want the graph traced without an upload.
   */
  dryRun?: boolean;
}

/** A resource plus its (bounded) collected content — the collect→audit payload. */
interface CollectedResource extends ResourceRef {
  /** Extracted current state (markdown, truncated); absent when collection failed. */
  content?: string;
  /** Why collection failed, when it did — surfaced to the audit as missing evidence. */
  error?: string;
}

/** One requirement check the model produced against the policy. */
interface CheckFinding {
  /** Resource id this check concerns, or a policy-level id. */
  id: string;
  /** The requirement being checked, in plain words. */
  requirement: string;
  /** Verdict for this requirement. */
  status: "pass" | "fail" | "unknown";
  /** What in the collected state supports the verdict. */
  evidence: string;
  /** Suggested fix when the verdict is `fail`. */
  remediation?: string;
}

/** Overall verdict of the audit. */
type AuditStatus = "compliant" | "non_compliant" | "needs_review";

/** The structured audit report, computed by `audit` and stored in shared. */
interface ComplianceReport {
  status: AuditStatus;
  summary: string;
  checks: CheckFinding[];
}

/** The payload a human delivers on the `attestation.signoff` signal. */
interface SignoffDecision {
  /** `approve` archives the attestation; anything else takes the safe reject branch. */
  decision?: "approve" | "reject";
  /** Who signed off; recorded in the archived attestation. */
  signer?: string;
  /** Optional free-text rationale carried through to the outcome. */
  notes?: string;
}

interface Shared extends Record<string, unknown> {
  policy: string;
  schedule: string;
  framework: string;
  signOffBy: string | null;
  dryRun: boolean;
  collectedAt: string;
  report: ComplianceReport;
  /** Slim resource references for the attestation; scraped bodies do NOT live here. */
  resources: Array<{ id: string; label: string; url: string; error?: string }>;
  /** Set when the run audited the built-in sample policy rather than the caller's. */
  note?: string;
}

type Ctx = AgentExecutionContext<Shared>;

// ─────────────────────────────────────────────────────────────── helpers ──
function must<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`missing shared state: ${name}`);
  return value;
}

/** Status glyph for the attestation checklist. */
function glyph(status: CheckFinding["status"]): string {
  return status === "pass" ? "✓" : status === "fail" ? "✗" : "?";
}

// ─────────────────────────────────────────────────────── model reasoning ──
/**
 * Ask the model to check the collected state against the policy and return a
 * structured report. Parsed defensively — a malformed reply degrades to a
 * `needs_review` verdict rather than throwing, so the sign-off gate still runs.
 */
async function runPolicyCheck(
  ctx: Ctx,
  policy: string,
  collected: CollectedResource[],
): Promise<ComplianceReport> {
  if (collected.length === 0) {
    return {
      status: "needs_review",
      summary: "No resources were collected, so nothing could be audited.",
      checks: [],
    };
  }
  const evidence = collected
    .map((r, i) => {
      const head = `[${i + 1}] ${r.label ?? r.id} (${r.url})`;
      if (r.error) return `${head}\n(collection failed: ${r.error})`;
      return `${head}\n${(r.content ?? "").slice(0, MAX_BODY_CHARS)}`;
    })
    .join("\n\n");
  const system =
    "You are a compliance auditor. Given a POLICY and the current STATE of a set " +
    "of resources (each: [n] label, url, then its collected text or a collection " +
    "error), check the state against the policy. Produce one check per distinct " +
    "requirement, cite the evidence you relied on, and suggest a remediation for " +
    "each failure. A requirement you cannot evaluate from the evidence is " +
    '"unknown", not "pass". Set the overall status to "compliant" only if every ' +
    'check passes, "non_compliant" if any check fails, else "needs_review".';
  const res = await ctx.sapiom.llm.run({
    request: {
      system,
      messages: [
        { role: "user", content: `POLICY:\n${policy}\n\nSTATE:\n${evidence}` },
      ],
      max_tokens: 900,
    },
    output: { name: AUDIT_TOOL, schema: AUDIT_SCHEMA },
  });
  return readReport(ctx.sapiom.llm.structuredOf(res, AUDIT_TOOL));
}

/**
 * The policy and evidence a zero-input run audits. The URL is a real, stable,
 * public page — our own published security policy — so the run does a genuine
 * scrape and the model checks genuine text. A placeholder host would 404 and the
 * audit would report "unknown" for every requirement, which is a report about
 * nothing.
 */
const SAMPLE_POLICY =
  "Every service must publish a security contact, state a disclosure process, " +
  "and name a response window.";
const SAMPLE_RESOURCES: ResourceRef[] = [
  {
    id: "sapiom-js-security-policy",
    url: "https://raw.githubusercontent.com/sapiom/sapiom-js/main/SECURITY.md",
    label: "Sapiom SDK security policy",
  },
];

// ─────────────────────────────────────────────────────────────── steps ──
/**
 * The entry contract — this agent's public API, and what the dashboard "Run
 * once" form renders its labelled fields from. `policy` carries the sample as
 * its `.default(...)` and `resources` defaults to an empty set, so a zero-input
 * run audits the built-in sample policy and evidence.
 */
const entryInput = z.object({
  resources: z
    .array(
      z.object({
        id: z.string(),
        url: z.string(),
        label: z.string().optional(),
      }),
    )
    .default([])
    .describe("The resources/config to collect and audit on each tick."),
  policy: z
    .string()
    .default(SAMPLE_POLICY)
    .describe(
      "The policy the collected state is checked against (free text or rules).",
    ),
  schedule: z
    .string()
    .optional()
    .describe('Cron cadence this audit runs on (e.g. "0 6 * * 1").'),
  framework: z
    .string()
    .optional()
    .describe(
      'Compliance framework label for the attestation title (e.g. "SOC 2 CC6").',
    ),
  signOffBy: z
    .string()
    .optional()
    .describe(
      "Who is expected to sign off; recorded in the attestation. Informational.",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe("Compute + pause but never perform the real archive upload."),
});

const collect = defineStep({
  name: "collect",
  inputSchema: entryInput,
  next: ["audit"],
  async run(input: EntryInput, ctx: Ctx) {
    const suppliedPolicy = input.policy?.trim() ?? "";
    const policy = suppliedPolicy || SAMPLE_POLICY;
    ctx.shared.set("policy", policy);
    ctx.shared.set("schedule", input.schedule?.trim() || DEFAULT_SCHEDULE);
    ctx.shared.set("framework", input.framework?.trim() || "General policy");
    ctx.shared.set("signOffBy", input.signOffBy?.trim() || null);
    ctx.shared.set("dryRun", input.dryRun === true);
    // Capture the audit timestamp once; steps re-run only on retry, so pin it
    // here and carry it forward rather than recomputing downstream.
    ctx.shared.set("collectedAt", new Date().toISOString());

    // Nothing to audit: use the sample policy and evidence so the run really
    // scrapes and really checks, and say in the output that both were ours.
    const supplied =
      input.resources && input.resources.length > 0 ? input.resources : null;
    if (!supplied) {
      ctx.shared.set(
        "note",
        "Audited the built-in sample policy against Sapiom's own published security policy. Pass your own `policy` and `resources` to audit yours.",
      );
    }
    const resources = (supplied ?? SAMPLE_RESOURCES).slice(0, MAX_RESOURCES);
    const collected: CollectedResource[] = [];
    for (const r of resources) {
      const base: ResourceRef = { id: r.id, url: r.url };
      if (r.label !== undefined) base.label = r.label;
      try {
        const page = await ctx.sapiom.search.scrape({
          url: r.url,
          formats: ["markdown"],
          onlyMainContent: true,
        });
        collected.push({
          ...base,
          label: r.label || page.metadata?.title || r.id,
          content: (page.markdown ?? "").slice(0, MAX_BODY_CHARS),
        });
      } catch (err) {
        // Collection fails routinely (auth walls, timeouts, dead endpoints).
        // Degrade per-item and forward the error as missing evidence — the audit
        // then marks that requirement "unknown" rather than the run aborting.
        ctx.logger.warn("collection failed; forwarding as missing evidence", {
          url: r.url,
          err: String(err),
        });
        collected.push({ ...base, error: String(err) });
      }
    }

    // Slim references for the attestation — the scraped bodies stop here.
    ctx.shared.set(
      "resources",
      collected.map((r) => ({
        id: r.id,
        label: r.label ?? r.id,
        url: r.url,
        ...(r.error !== undefined && { error: r.error }),
      })),
    );
    ctx.logger.info("collected resources", {
      total: collected.length,
      failed: collected.filter((r) => r.error).length,
    });
    return goto("audit", { collected });
  },
});

const audit = defineStep({
  name: "audit",
  next: ["review"],
  async run(input: { collected: CollectedResource[] }, ctx: Ctx) {
    const policy = must(ctx.shared.get("policy"), "policy");
    const report = await runPolicyCheck(ctx, policy, input.collected ?? []);
    ctx.shared.set("report", report);
    ctx.logger.info("policy check complete", {
      status: report.status,
      checks: report.checks.length,
      failing: report.checks.filter((c) => c.status === "fail").length,
    });
    return goto("review", {});
  },
});

const review = defineStep({
  name: "review",
  next: ["pending"],
  // Static graph edge: on the sign-off signal, resume at `onSignoff`. Must match
  // the `pauseUntilSignal` directive below.
  pause: { signal: SIGNOFF_SIGNAL, resumeStep: "onSignoff" },
  async run(_input: unknown, ctx: Ctx) {
    const report = must(ctx.shared.get("report"), "report");
    const framework = ctx.shared.get("framework") ?? "General policy";
    const signOffBy = ctx.shared.get("signOffBy") ?? null;

    // Nobody is assigned to sign off, so nothing will ever fire the sign-off
    // signal and pausing here would suspend the run forever. Stop holding the
    // DRAFT attestation instead.
    //
    // What this must never do: resuming with an empty payload fabricates no
    // consent — `onSignoff` only proceeds on an explicit approve — but it lands
    // on `rejected`, which reads to a first-run user as "the audit failed" and
    // teaches the inverse of what the gate is for. And an attestation is a
    // compliance artifact: nothing here may imply one was filed.
    if (!signOffBy) {
      ctx.logger.info("no signer configured — terminating at the gate", {
        framework,
        status: report.status,
      });
      return goto("pending", {});
    }

    // No notification capability here (by design — this template's surface is
    // cron + scrape + LLM + pause + file storage). The pending attestation is in
    // the run's output/logs; the reviewer reads it there and fires the signal.
    ctx.logger.info("attestation ready for sign-off; pausing", {
      framework,
      status: report.status,
      signOffBy,
      checks: report.checks.length,
    });

    // Suspend at $0 until a human fires the sign-off signal for this run.
    return pauseUntilSignal({
      signal: SIGNOFF_SIGNAL,
      resumeStep: "onSignoff",
      correlationId: ctx.executionId,
    });
  },
});

/**
 * The gate's off-ramp when no signer is assigned. Terminal, and deliberately
 * neither `archived` nor `rejected`: nobody signed anything. The attestation is
 * stamped as a draft, because a filed attestation is a compliance record and this
 * is not one.
 */
const pending = defineStep({
  name: "pending",
  next: [],
  terminal: true,
  async run(_input: unknown, ctx: Ctx) {
    const report = must(ctx.shared.get("report"), "report");
    const framework = ctx.shared.get("framework") ?? "General policy";
    const resources = ctx.shared.get("resources") ?? [];
    const note = ctx.shared.get("note");
    return terminate(
      {
        filed: false,
        outcome: "pending-signoff",
        pending: true,
        attestation: "DRAFT — not a filed attestation. Nobody has signed this.",
        framework,
        status: report.status,
        checks: report.checks,
        resources,
        signedBy: null,
        unmet: ["signOffBy"],
        note: [
          "The attestation is drafted and nothing was signed, filed, or archived.",
          "Set a `signOffBy` address and re-run to route it for sign-off, or fire the",
          `\`${SIGNOFF_SIGNAL}\` signal with \`{ "decision": "approve", "signer": "you@example.com" }\``,
          "to file it.",
          note,
        ]
          .filter(Boolean)
          .join(" "),
      },
      { reason: "no signer configured" },
    );
  },
});

const onSignoff = defineStep({
  name: "onSignoff",
  next: ["archive", "rejected"],
  // `payload` IS the sign-off signal body.
  async run(payload: SignoffDecision, ctx: Ctx) {
    // Safe default: only an explicit `approve` archives — the whole point of the
    // gate is that no attestation is filed without a deliberate human sign-off.
    const approved = payload?.decision === "approve";
    ctx.logger.info("sign-off decision", {
      decision: payload?.decision ?? "(none)",
      approved,
      signer: payload?.signer ?? null,
    });
    if (!approved) {
      return goto("rejected", {
        reason: payload?.notes ?? "not-approved",
      });
    }
    return goto("archive", {
      signer: payload?.signer ?? null,
      notes: payload?.notes ?? null,
    });
  },
});

const archive = defineStep({
  name: "archive",
  next: [],
  terminal: true,
  async run(input: { signer: string | null; notes: string | null }, ctx: Ctx) {
    const report = must(ctx.shared.get("report"), "report");
    const framework = ctx.shared.get("framework") ?? "General policy";
    const schedule = ctx.shared.get("schedule") ?? DEFAULT_SCHEDULE;
    const collectedAt = ctx.shared.get("collectedAt") ?? "";
    const resources = ctx.shared.get("resources") ?? [];
    const dryRun = ctx.shared.get("dryRun") ?? true;
    const signer = input?.signer ?? ctx.shared.get("signOffBy") ?? null;
    const signedAt = new Date().toISOString();

    const attestation = buildAttestation({
      framework,
      schedule,
      collectedAt,
      signedAt,
      signer,
      notes: input?.notes ?? null,
      report,
      resources,
    });
    const fileName = `attestation-${collectedAt.slice(0, 10) || "latest"}.md`;

    if (dryRun) {
      // Offline / preview: the single irreversible action (the upload PUT, a raw
      // fetch that is NOT a stubbed capability) is skipped. Everything up to here
      // — collect, audit, the sign-off gate — already ran for real.
      ctx.logger.info("dry run: skipping the attestation upload", {
        status: report.status,
        fileName,
      });
      return terminate({
        archived: false,
        dryRun: true,
        status: report.status,
        framework,
        signer,
        signedAt,
        fileName,
        attestation,
        fileId: null,
        downloadUrl: null,
      });
    }

    // ── The single billed/irreversible action ──────────────────────────────
    // Reached ONLY after a human approved. Persist the signed attestation as a
    // durable, private file and hand back a download URL for the archive.
    const bytes = new TextEncoder().encode(attestation);
    const { fileId, uploadUrl, requiredHeaders } =
      await ctx.sapiom.fileStorage.upload({
        contentType: "text/markdown",
        fileName,
        fileSize: bytes.byteLength,
        visibility: "private",
      });
    // You own the bytes transfer: PUT them to the presigned URL yourself.
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: requiredHeaders,
      body: bytes,
    });
    if (!put.ok) {
      const detail = await put.text().catch(() => put.statusText);
      throw new Error(`attestation upload failed: ${put.status} ${detail}`);
    }
    const { downloadUrl } = await ctx.sapiom.fileStorage.getDownloadUrl(fileId);

    ctx.logger.info("attestation archived", {
      fileId,
      status: report.status,
      signer,
    });
    return terminate({
      archived: true,
      dryRun: false,
      status: report.status,
      framework,
      signer,
      signedAt,
      fileName,
      fileId,
      downloadUrl,
    });
  },
});

const rejected = defineStep({
  name: "rejected",
  next: [],
  terminal: true,
  async run(input: { reason?: string }, ctx: Ctx) {
    const report = must(ctx.shared.get("report"), "report");
    // Nothing was archived — the sign-off was declined (or absent). The audit
    // findings are still returned so a reviewer can act on them.
    ctx.logger.info("sign-off declined — nothing archived", {
      status: report.status,
      reason: input?.reason ?? "not-approved",
    });
    return terminate({
      archived: false,
      outcome: "rejected",
      status: report.status,
      reason: input?.reason ?? "not-approved",
      summary: report.summary,
      checks: report.checks,
    });
  },
});

// ─────────────────────────────────────────────────────── attestation body ──
function buildAttestation(a: {
  framework: string;
  schedule: string;
  collectedAt: string;
  signedAt: string;
  signer: string | null;
  notes: string | null;
  report: ComplianceReport;
  resources: Array<{ id: string; label: string; url: string; error?: string }>;
}): string {
  const checks =
    a.report.checks.length > 0
      ? a.report.checks
          .map((c) => {
            const remediation =
              c.status === "fail" && c.remediation
                ? `\n  - Remediation: ${c.remediation}`
                : "";
            return `- [${glyph(c.status)}] ${c.requirement} — ${c.status}: ${c.evidence}${remediation}`;
          })
          .join("\n")
      : "_No checks were produced._";
  const sources =
    a.resources.length > 0
      ? a.resources
          .map(
            (r) =>
              `- ${r.label} (${r.url})${r.error ? ` — collection failed: ${r.error}` : ""}`,
          )
          .join("\n")
      : "_No resources were collected._";
  return [
    `# Compliance Attestation — ${a.framework}`,
    "",
    `- **Overall status:** ${a.report.status}`,
    `- **Audited at:** ${a.collectedAt || "(unknown)"}`,
    `- **Cadence:** ${a.schedule}`,
    `- **Resources audited:** ${a.resources.length}`,
    "",
    "## Summary",
    a.report.summary || "_No summary._",
    "",
    "## Checks",
    checks,
    "",
    "## Sign-off",
    `- **Decision:** approved`,
    `- **Signed by:** ${a.signer ?? "(unspecified)"}`,
    `- **Signed at:** ${a.signedAt}`,
    ...(a.notes ? [`- **Notes:** ${a.notes}`] : []),
    "",
    "## Sources",
    sources,
  ].join("\n");
}

// ────────────────────────────────────────────────────── structured output ──
/**
 * The forced tool call `audit` reads its report out of. `llm.run`'s `output`
 * appends this tool to the request and pins `tool_choice` to it, so the report
 * arrives as a typed `tool_use` block — there is no prose to slice and no JSON
 * to hand-parse.
 */
const AUDIT_TOOL = "emit_compliance_report";

const AUDIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["compliant", "non_compliant", "needs_review"],
      description:
        '"compliant" only if every check passes, "non_compliant" if any check fails, else "needs_review".',
    },
    summary: {
      type: "string",
      description: "One-paragraph summary of the audit.",
    },
    checks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "The resource id this check concerns, or a policy-level id.",
          },
          requirement: {
            type: "string",
            description: "The requirement being checked, in plain words.",
          },
          status: {
            type: "string",
            enum: ["pass", "fail", "unknown"],
            description:
              'A requirement you cannot evaluate from the evidence is "unknown", never "pass".',
          },
          evidence: {
            type: "string",
            description: "What in the collected state supports the verdict.",
          },
          remediation: {
            type: "string",
            description: "Suggested fix — required when the verdict is `fail`.",
          },
        },
        required: ["id", "requirement", "status", "evidence"],
        additionalProperties: false,
      },
      description: "One check per distinct requirement.",
    },
  },
  required: ["status", "summary", "checks"],
  additionalProperties: false,
};

/**
 * Read the forced tool call back into a `ComplianceReport`.
 *
 * Throws when the model returned no such block, no overall status, no summary,
 * or no checks. `needs_review` looks like a safe default and is not one: it is a
 * compliance verdict, it goes to a human for signature, and it gets archived as
 * an attestation. "The auditor returned no usable report" used to be filed
 * under the same status as a genuine borderline finding, with an empty check
 * list, on a run that reported `succeeded`.
 */
export function readReport(structured: unknown): ComplianceReport {
  if (structured === null || typeof structured !== "object") {
    throw new Error(
      "audit: the model returned no structured report — refusing to attest to an invented verdict.",
    );
  }
  const obj = structured as Record<string, unknown>;
  const status = coerceStatus(obj.status);
  if (!status) {
    throw new Error(
      `audit: the model returned no usable overall status (${JSON.stringify(obj.status)}) — refusing to invent one.`,
    );
  }
  if (typeof obj.summary !== "string" || obj.summary.trim() === "") {
    throw new Error(
      "audit: the model returned no audit summary — refusing to invent one.",
    );
  }
  const checks = (Array.isArray(obj.checks) ? obj.checks : [])
    .map(coerceCheck)
    .filter((c): c is CheckFinding => c !== null);
  if (checks.length === 0) {
    throw new Error(
      "audit: the model returned no checks — refusing to report the policy as audited.",
    );
  }
  return { status, summary: obj.summary.trim(), checks };
}

/**
 * The overall verdict, or `null` when the model named none. Deliberately NOT
 * defaulted to `needs_review`: that is itself a verdict a human signs.
 */
function coerceStatus(value: unknown): AuditStatus | null {
  return value === "compliant" ||
    value === "non_compliant" ||
    value === "needs_review"
    ? value
    : null;
}

function coerceCheck(entry: unknown): CheckFinding | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const requirement =
    typeof e.requirement === "string" ? e.requirement.trim() : "";
  if (!requirement) return null;
  const status: CheckFinding["status"] =
    e.status === "pass" || e.status === "fail" ? e.status : "unknown";
  const check: CheckFinding = {
    id: typeof e.id === "string" ? e.id : requirement.slice(0, 40),
    requirement,
    status,
    evidence:
      typeof e.evidence === "string" ? e.evidence : "(no evidence cited)",
  };
  if (status === "fail" && typeof e.remediation === "string" && e.remediation) {
    check.remediation = e.remediation;
  }
  return check;
}

export const agent = defineAgent<EntryInput, Shared>({
  name: "scheduled-compliance-audit",
  entry: "collect",
  steps: { collect, audit, review, onSignoff, archive, pending, rejected },
});
