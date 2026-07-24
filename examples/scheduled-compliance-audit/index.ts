import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";

/**
 * Scheduled Compliance Audit + Attestation — the recurring "prove we're still
 * compliant" pattern.
 *
 * On each tick it collects the current state of the resources you point it at
 * (config pages, status endpoints, policy docs — read with `web.scrape`), asks
 * an LLM (`ctx.sapiom.models.run` — the live x402 path) to check that state
 * against your `policy` and produce a structured finding, then **pauses for a
 * human sign-off**. Only after a person explicitly approves does it archive the
 * signed attestation as a durable file (`fileStorage.upload`) — because an
 * attestation is a record that a human reviewed and signed off, auto-archiving
 * one without a real sign-off would be a lie.
 *
 *   collect (web.scrape) → audit (models.run) ─(pause: attestation.signoff, $0)─▶ onSignoff
 *                                                                                    │
 *                                              reject ◀───────────────────────────────┼─▶ approve
 *                                                │                                     ▼
 *                                            rejected (terminal)                  archive (fileStorage, terminal)
 *
 * The durable pause (`pauseUntilSignal`) suspends the run at $0 until a person
 * fires the sign-off signal — it is a runtime primitive, not a metered
 * capability. The billed calls are the scrapes (`web.scrape`), the model
 * reasoning (`ctx.sapiom.models.run` — `ctx.sapiom.llm` does NOT exist), and the
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
  /** Compute + pause but never perform the real archive upload. `run_local` sets this. */
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
    'check passes, "non_compliant" if any check fails, else "needs_review". ' +
    "Reply with ONLY minified JSON: " +
    '{"status":"compliant|non_compliant|needs_review","summary":string,' +
    '"checks":[{"id":string,"requirement":string,"status":"pass|fail|unknown",' +
    '"evidence":string,"remediation":string}]}.';
  const res = await ctx.sapiom.models.run({
    system,
    prompt: `POLICY:\n${policy}\n\nSTATE:\n${evidence}`,
    maxTokens: 900,
  });
  return coerceReport(res.output);
}

// ─────────────────────────────────────────────────────────────── steps ──
const collect = defineStep({
  name: "collect",
  next: ["audit"],
  async run(input: EntryInput, ctx: Ctx) {
    const policy = input.policy?.trim() ?? "";
    ctx.shared.set("policy", policy);
    ctx.shared.set("schedule", input.schedule?.trim() || DEFAULT_SCHEDULE);
    ctx.shared.set("framework", input.framework?.trim() || "General policy");
    ctx.shared.set("signOffBy", input.signOffBy?.trim() || null);
    ctx.shared.set("dryRun", input.dryRun === true);
    // Capture the audit timestamp once; steps re-run only on retry, so pin it
    // here and carry it forward rather than recomputing downstream.
    ctx.shared.set("collectedAt", new Date().toISOString());

    const resources = (input.resources ?? []).slice(0, MAX_RESOURCES);
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
  next: [],
  // Static graph edge: on the sign-off signal, resume at `onSignoff`. Must match
  // the `pauseUntilSignal` directive below.
  pause: { signal: SIGNOFF_SIGNAL, resumeStep: "onSignoff" },
  async run(_input: unknown, ctx: Ctx) {
    const report = must(ctx.shared.get("report"), "report");
    const framework = ctx.shared.get("framework") ?? "General policy";
    const signOffBy = ctx.shared.get("signOffBy") ?? null;

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

// ─────────────────────────────────────────────────────── output parsing ──
/** Coerce the audit-step model output into a `ComplianceReport`, with fallbacks. */
function coerceReport(output: string | null): ComplianceReport {
  const fallback: ComplianceReport = {
    status: "needs_review",
    summary: "The auditor returned no usable report; a human should review.",
    checks: [],
  };
  const obj = extractJson(output);
  if (!obj) return fallback;

  const status = coerceStatus(obj.status);
  const summary =
    typeof obj.summary === "string" && obj.summary.trim()
      ? obj.summary.trim()
      : fallback.summary;
  const checks = Array.isArray(obj.checks)
    ? obj.checks.map(coerceCheck).filter((c): c is CheckFinding => c !== null)
    : [];
  return { status, summary, checks };
}

function coerceStatus(value: unknown): AuditStatus {
  return value === "compliant" || value === "non_compliant"
    ? value
    : "needs_review";
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
  name: "scheduled-compliance-audit",
  entry: "collect",
  steps: { collect, audit, review, onSignoff, archive, rejected },
});
