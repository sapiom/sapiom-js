import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";

/**
 * Proposal / Quote Generator — requirements in, a signed-off PDF quote out.
 *
 * The "draft → render → get sign-off → send" shape a salesperson or agency runs
 * by hand for every inbound request, done as one durable workflow:
 *
 *   draft ─▶ render ─▶ review ─(pause: proposal.decision, $0 while idle)─▶ onDecision
 *  (models.run) (sandbox+                                                    │
 *               fileStorage)                                approve ◀─────────┼─▶ reject
 *                                                             ▼               ▼
 *                                                           send          rejected
 *                                                        (terminal)       (terminal)
 *
 *   1. draft — an LLM (`ctx.sapiom.models.run`) turns the free-text requirement
 *      into a structured proposal: a title, a summary, a scope list, priced line
 *      items, and terms. Deterministic code then totals the line items.
 *   2. render — spin up a sandbox (`ctx.sapiom.sandboxes.create`), lay the
 *      proposal out as a PDF with a tiny self-contained Node script, and persist
 *      the bytes to file storage (`ctx.sapiom.fileStorage.upload`). The sandbox
 *      is torn down before the step returns.
 *   3. review — email the internal approver a summary and the PDF link
 *      (`ctx.sapiom.email`), then **block on a human approval signal**. The run
 *      suspends at $0 until someone decides.
 *   4. onDecision — its input IS the approval payload. Only an explicit
 *      `{ decision: "approve" }` proceeds; anything else takes the safe reject
 *      branch — nothing goes out to the client without a deliberate yes.
 *   5. send — the one outward action: email the finished proposal to the client.
 *      A `dryRun` guard makes it a no-op so a deployed run can be traced safely.
 *
 * Offline: `run_local` stubs the capabilities and auto-resumes the pause. A
 * resume with no payload takes the safe reject branch, so the whole graph traces
 * end to end for free. The sandbox exec returns empty output under stubs, so
 * `render` skips the real byte upload but still walks its full shape. Fire a real
 * `proposal.decision` signal (in dev, via the MCP `workflow_signal` tool — see
 * README) to drive the approve → send path.
 *
 * `pauseUntilSignal` is a runtime primitive, not a metered capability. The billed
 * calls are the model reasoning (`ctx.sapiom.models.run` — the live x402 path;
 * `ctx.sapiom.llm` does NOT exist), the sandbox render, the file upload, and the
 * emails.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** The signal a human fires to approve or reject the drafted proposal. */
const DECISION_SIGNAL = "proposal.decision";

/** Username for the inbox we send from (created once, then reused). */
const SENDER_USERNAME = "proposals";

/** Package the sandbox installs to lay out the PDF (pure JS, no native deps). */
const PDF_PACKAGE = "pdf-lib@1.17.1";

/** Bounds so a runaway model output can't produce an unusable quote. */
const MAX_LINE_ITEMS = 25;
const MAX_SCOPE_ITEMS = 12;

// ─────────────────────────────────────────────────────────────── shapes ──
/** String-only config bag (matches how templates receive their `config`). */
type Config = Record<string, string>;

/** Who the quote is for / from — shown on the PDF and used for delivery. */
interface Party {
  name?: string;
  company?: string;
  email?: string;
}

interface EntryInput {
  /** The free-text requirement / RFP / brief to quote against. */
  request: string;
  /** The client the proposal is for. `email` is where the final PDF is sent. */
  client?: Party;
  /** Who the proposal is from (your company). Shown on the PDF. */
  from?: Party;
  /** ISO 4217 currency code for the quote (default "USD"). */
  currency?: string;
  /** Tax rate as a fraction, e.g. 0.08 for 8% (default 0 — no tax line). */
  taxRate?: number;
  /** Who signs off before the client sees it. Falls back to `config.APPROVER_EMAIL`. */
  approver?: string;
  /** Where to send the approved proposal. Falls back to `client.email` / `config.CLIENT_EMAIL`. */
  recipientEmail?: string;
  /** Draft + render + get sign-off, but never send the client email. `run_local` behaviour. */
  dryRun?: boolean;
  /** String-only config bag (approver / client fallbacks). */
  config?: Config;
}

/** One priced line on the quote, as the model returns it. */
interface ProposalLine {
  description: string;
  quantity: number;
  unitPrice: number;
}

/** The structured proposal the model drafts from the request. */
interface ProposalDraft {
  title: string;
  summary: string;
  scope: string[];
  lineItems: ProposalLine[];
  terms: string;
}

/** Computed money totals (never trusted from the model). */
interface Totals {
  subtotal: number;
  tax: number;
  total: number;
}

/** The payload the human delivers on the `proposal.decision` signal. */
interface ApprovalDecision {
  /** `approve` sends to the client; anything else (or absent) rejects safely. */
  decision?: "approve" | "reject";
  /** Optional free-text note carried through to the outcome. */
  notes?: string;
}

/** State that survives the pause, read back after the resume. */
interface Shared extends Record<string, unknown> {
  request: string;
  currency: string;
  taxRate: number;
  client: Party;
  from: Party;
  approver: string | null;
  recipientEmail: string | null;
  dryRun: boolean;
  draft: ProposalDraft;
  totals: Totals;
  quoteNumber: string;
  fileId: string | null;
  downloadUrl: string | null;
}

type Ctx = AgentExecutionContext<Shared>;

// ─────────────────────────────────────────────────────────────── helpers ──
function must<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`missing shared state: ${name}`);
  return value;
}

/** A stable, human-readable quote id derived from the run (survives retries). */
function quoteNumberFor(executionId: string): string {
  const tail = executionId
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-6)
    .toUpperCase();
  return `Q-${tail || "000000"}`;
}

/** Reuse an existing inbox to send from, else provision one. */
async function resolveSenderInbox(ctx: Ctx): Promise<string> {
  const existing = await ctx.sapiom.email.inboxes.list({ limit: 1 });
  if (existing.inboxes.length > 0) return existing.inboxes[0].inboxId;
  const inbox = await ctx.sapiom.email.inboxes.create({
    username: SENDER_USERNAME,
    displayName: "Proposals",
  });
  return inbox.inboxId;
}

/**
 * Send a notification, degrading gracefully when there's no recipient. A missing
 * address is an expected outcome (no approver configured, no client email) — log
 * and skip rather than failing the run.
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

/** Sum the priced line items — the total is computed here, never from the model. */
function computeTotals(lineItems: ProposalLine[], taxRate: number): Totals {
  const subtotal = lineItems.reduce(
    (sum, li) => sum + li.quantity * li.unitPrice,
    0,
  );
  const tax = subtotal * taxRate;
  return {
    subtotal: round2(subtotal),
    tax: round2(tax),
    total: round2(subtotal + tax),
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

// ─────────────────────────────────────────────────────── model reasoning ──
/** Draft the proposal from the free-text request (reversible prep). */
async function draftProposal(
  ctx: Ctx,
  request: string,
  currency: string,
): Promise<ProposalDraft> {
  const system =
    "You are a solutions consultant drafting a client proposal and price quote " +
    "from a request. Produce a short title, a one-paragraph summary, a scope " +
    "list of what's included, and priced line items (a clear deliverable, a " +
    `quantity, and a unit price as a plain number in ${currency}). Price the ` +
    "work realistically for the request. Add brief terms (validity + payment). " +
    "Reply with ONLY minified JSON: " +
    '{"title":string,"summary":string,"scope":string[],' +
    '"lineItems":[{"description":string,"quantity":number,"unitPrice":number}],' +
    '"terms":string}.';
  const res = await ctx.sapiom.models.run({
    prompt: request,
    system,
    maxTokens: 900,
  });
  return coerceDraft(res.output, request);
}

// ─────────────────────────────────────────────────────────────── steps ──
const draft = defineStep({
  name: "draft",
  next: ["render"],
  async run(input: EntryInput, ctx: Ctx) {
    const request = input.request?.trim() ?? "";
    if (!request) throw new Error("`request` is required");
    const config = input.config ?? {};
    const currency = (input.currency?.trim() || "USD").toUpperCase();
    const taxRate =
      typeof input.taxRate === "number" && Number.isFinite(input.taxRate)
        ? Math.max(0, input.taxRate)
        : 0;

    ctx.shared.set("request", request);
    ctx.shared.set("currency", currency);
    ctx.shared.set("taxRate", taxRate);
    ctx.shared.set("client", input.client ?? {});
    ctx.shared.set("from", input.from ?? {});
    ctx.shared.set(
      "approver",
      input.approver?.trim() || config.APPROVER_EMAIL || null,
    );
    ctx.shared.set(
      "recipientEmail",
      input.recipientEmail?.trim() ||
        input.client?.email?.trim() ||
        config.CLIENT_EMAIL ||
        null,
    );
    ctx.shared.set("dryRun", input.dryRun === true);
    ctx.shared.set("quoteNumber", quoteNumberFor(ctx.executionId));

    // Reversible prep: draft the proposal, then total the line items in code.
    const proposal = await draftProposal(ctx, request, currency);
    const totals = computeTotals(proposal.lineItems, taxRate);
    ctx.shared.set("draft", proposal);
    ctx.shared.set("totals", totals);
    ctx.logger.info("drafted proposal", {
      title: proposal.title,
      lineItems: proposal.lineItems.length,
      total: totals.total,
    });
    return goto("render", {});
  },
});

const render = defineStep({
  name: "render",
  next: ["review"],
  async run(_input: unknown, ctx: Ctx) {
    const draftDoc = must(ctx.shared.get("draft"), "draft");
    const totals = must(ctx.shared.get("totals"), "totals");
    const currency = must(ctx.shared.get("currency"), "currency");
    const quoteNumber = must(ctx.shared.get("quoteNumber"), "quoteNumber");
    const from = ctx.shared.get("from") ?? {};
    const client = ctx.shared.get("client") ?? {};

    const fileName = `${quoteNumber}.pdf`;
    const boxName = `proposal-${quoteNumber.toLowerCase()}`;
    const proposalJson = JSON.stringify({
      quoteNumber,
      currency,
      from,
      client,
      draft: draftDoc,
      totals,
    });

    // Lay out the PDF in a throwaway sandbox, then read the bytes back as base64.
    // A sandbox is torn down in `finally` so a render failure never leaks compute.
    let pdfBase64 = "";
    const box = await ctx.sapiom.sandboxes.create({ name: boxName });
    try {
      await box.writeFile("proposal.json", proposalJson);
      await box.writeFile("render.mjs", RENDER_SCRIPT);
      // Install the (pure-JS) PDF library and render. `--no-save` keeps it out of
      // a package.json we don't ship; errors surface via a non-zero exit below.
      const built = await box.exec(
        `npm install --no-save --no-audit --no-fund --loglevel=error ${PDF_PACKAGE} && node render.mjs`,
        { timeout: 180_000 },
      );
      if (built.exitCode !== 0) {
        ctx.logger.error("pdf render failed", {
          exitCode: built.exitCode,
          stderr: built.stderr.slice(-500),
        });
        throw new Error(`PDF render failed (exit ${built.exitCode})`);
      }
      // Read the PDF as base64 so binary bytes survive the text-only exec channel.
      const read = await box.exec(
        `base64 -w0 ${fileName} || base64 ${fileName}`,
      );
      pdfBase64 = read.stdout.replace(/\s+/g, "");
    } finally {
      await box.destroy().catch((err) => {
        ctx.logger.warn("sandbox destroy failed", { err: String(err) });
      });
    }

    // Persist the bytes to file storage. `upload` hands back a presigned URL we
    // PUT the bytes to ourselves. Under `run_local` the sandbox exec is stubbed
    // (empty output), so there are no bytes to PUT — we still walk the upload
    // shape and return a (stub) fileId, keeping the offline trace complete.
    const bytes = Buffer.from(pdfBase64, "base64");
    const upload = await ctx.sapiom.fileStorage.upload({
      contentType: "application/pdf",
      fileName,
      fileSize: bytes.length,
      visibility: "private",
    });
    if (bytes.length > 0) {
      const res = await fetch(upload.uploadUrl, {
        method: "PUT",
        headers: upload.requiredHeaders,
        body: bytes,
      });
      if (!res.ok) {
        throw new Error(
          `file upload PUT failed: ${res.status} ${res.statusText}`,
        );
      }
    } else {
      ctx.logger.warn(
        "no PDF bytes rendered — skipping upload PUT (local/stub)",
      );
    }
    const link = await ctx.sapiom.fileStorage.getDownloadUrl(upload.fileId);
    ctx.shared.set("fileId", upload.fileId);
    ctx.shared.set("downloadUrl", link.downloadUrl);
    ctx.logger.info("proposal rendered", {
      fileId: upload.fileId,
      bytes: bytes.length,
    });
    return goto("review", {});
  },
});

const review = defineStep({
  name: "review",
  next: [],
  // Static graph edge: on the decision signal, resume at `onDecision`. Must match
  // the `pauseUntilSignal` directive below.
  pause: { signal: DECISION_SIGNAL, resumeStep: "onDecision" },
  async run(_input: unknown, ctx: Ctx) {
    const draftDoc = must(ctx.shared.get("draft"), "draft");
    const totals = must(ctx.shared.get("totals"), "totals");
    const currency = must(ctx.shared.get("currency"), "currency");
    const quoteNumber = must(ctx.shared.get("quoteNumber"), "quoteNumber");
    const approver = ctx.shared.get("approver") ?? null;
    const downloadUrl = ctx.shared.get("downloadUrl") ?? null;

    // Email the internal approver a summary + the PDF link before anything goes
    // to the client.
    await notify(
      ctx,
      approver,
      `Approval needed: ${draftDoc.title} (${quoteNumber})`,
      buildApproverEmail(
        draftDoc,
        totals,
        currency,
        downloadUrl,
        ctx.executionId,
      ),
    );

    ctx.logger.info("approver notified; pausing for decision", {
      approver,
      quoteNumber,
    });

    // Suspend at $0 until a human fires the approval signal for this run.
    return pauseUntilSignal({
      signal: DECISION_SIGNAL,
      resumeStep: "onDecision",
      correlationId: ctx.executionId,
    });
  },
});

const onDecision = defineStep({
  name: "onDecision",
  next: ["send", "rejected"],
  // `payload` IS the approval signal body.
  async run(payload: ApprovalDecision, ctx: Ctx) {
    // Safe default: only an explicit `approve` sends the proposal to the client.
    const approved = payload?.decision === "approve";
    ctx.logger.info("approval decision", {
      decision: payload?.decision ?? "(none)",
      approved,
    });
    if (!approved) return goto("rejected", { notes: payload?.notes });
    return goto("send", { notes: payload?.notes });
  },
});

const send = defineStep({
  name: "send",
  next: [],
  terminal: true,
  async run(input: { notes?: string }, ctx: Ctx) {
    const draftDoc = must(ctx.shared.get("draft"), "draft");
    const totals = must(ctx.shared.get("totals"), "totals");
    const currency = must(ctx.shared.get("currency"), "currency");
    const quoteNumber = must(ctx.shared.get("quoteNumber"), "quoteNumber");
    const client = ctx.shared.get("client") ?? {};
    const recipient = ctx.shared.get("recipientEmail") ?? null;
    const downloadUrl = ctx.shared.get("downloadUrl") ?? null;
    const fileId = ctx.shared.get("fileId") ?? null;
    const dryRun = ctx.shared.get("dryRun") ?? false;

    if (dryRun) {
      // Deployed preview: skip the one outward action. Everything up to here
      // (draft, render, approval) already ran for real.
      ctx.logger.info("dry run — skipping client email", { quoteNumber });
      return terminate({
        sent: false,
        dryRun: true,
        outcome: "approved-dry-run",
        quoteNumber,
        fileId,
        downloadUrl,
        total: totals.total,
      });
    }

    // ── The one outward action ─────────────────────────────────────────────
    const sent = await notify(
      ctx,
      recipient,
      `Your proposal: ${draftDoc.title} (${quoteNumber})`,
      buildClientEmail(draftDoc, totals, currency, downloadUrl, client),
    );

    ctx.logger.info("proposal sent", { recipient, quoteNumber, sent });
    return terminate({
      sent,
      dryRun: false,
      outcome: sent ? "sent" : "approved-no-recipient",
      quoteNumber,
      fileId,
      downloadUrl,
      total: totals.total,
      notes: input?.notes ?? null,
    });
  },
});

const rejected = defineStep({
  name: "rejected",
  next: [],
  terminal: true,
  async run(input: { notes?: string }, ctx: Ctx) {
    const quoteNumber = ctx.shared.get("quoteNumber") ?? null;
    const fileId = ctx.shared.get("fileId") ?? null;
    // Nothing went to the client, so rejecting is a clean stop: the draft PDF is
    // still in file storage for a human to pick up or revise.
    ctx.logger.info("rejected — nothing sent to the client", { quoteNumber });
    return terminate({
      sent: false,
      outcome: "rejected",
      quoteNumber,
      fileId,
      notes: input?.notes ?? null,
    });
  },
});

// ─────────────────────────────────────────────────────── email bodies ──
function buildApproverEmail(
  d: ProposalDraft,
  totals: Totals,
  currency: string,
  downloadUrl: string | null,
  executionId: string,
): string {
  return [
    `Proposal drafted for approval: ${d.title}`,
    "",
    d.summary,
    "",
    "Line items:",
    ...d.lineItems.map(
      (li) =>
        `- ${li.description} — ${li.quantity} × ${money(li.unitPrice, currency)} = ${money(li.quantity * li.unitPrice, currency)}`,
    ),
    "",
    `Subtotal: ${money(totals.subtotal, currency)}`,
    ...(totals.tax > 0 ? [`Tax: ${money(totals.tax, currency)}`] : []),
    `Total: ${money(totals.total, currency)}`,
    "",
    downloadUrl ? `PDF: ${downloadUrl}` : "(PDF link unavailable)",
    "",
    "Nothing has been sent to the client. Fire the `proposal.decision` signal",
    'with {"decision":"approve"} to send it, or {"decision":"reject"} to stop.',
    `Run: ${executionId}`,
  ].join("\n");
}

function buildClientEmail(
  d: ProposalDraft,
  totals: Totals,
  currency: string,
  downloadUrl: string | null,
  client: Party,
): string {
  return [
    `Hi ${client.name ?? "there"},`,
    "",
    `Please find our proposal, ${d.title}, attached below.`,
    "",
    d.summary,
    "",
    `Total: ${money(totals.total, currency)}`,
    "",
    downloadUrl
      ? `View the full proposal (PDF): ${downloadUrl}`
      : "(PDF link unavailable — we'll follow up shortly.)",
    "",
    d.terms,
  ].join("\n");
}

// ─────────────────────────────────────────────────────── output parsing ──
/**
 * Coerce the draft-step model output into a `ProposalDraft`, defensively. A model
 * may wrap the JSON in prose or fences, so we slice to the outermost object and
 * fall back to a minimal single-line quote when anything is off — the pipeline
 * still renders and runs end to end rather than failing on a malformed draft.
 */
function coerceDraft(output: string | null, request: string): ProposalDraft {
  const fallback: ProposalDraft = {
    title: "Proposal",
    summary: request.slice(0, 200) || "(no request supplied)",
    scope: [],
    lineItems: [
      { description: "Professional services", quantity: 1, unitPrice: 0 },
    ],
    terms: "Valid for 30 days. Payment due within 30 days of acceptance.",
  };
  const obj = extractJson(output);
  if (!obj) return fallback;

  const title =
    typeof obj.title === "string" && obj.title.trim()
      ? obj.title.trim()
      : fallback.title;
  const summary =
    typeof obj.summary === "string" && obj.summary.trim()
      ? obj.summary.trim()
      : fallback.summary;
  const scope = Array.isArray(obj.scope)
    ? obj.scope
        .filter(
          (s): s is string => typeof s === "string" && s.trim().length > 0,
        )
        .slice(0, MAX_SCOPE_ITEMS)
    : [];
  const lineItems = Array.isArray(obj.lineItems)
    ? obj.lineItems
        .map(coerceLine)
        .filter((li): li is ProposalLine => li !== null)
        .slice(0, MAX_LINE_ITEMS)
    : [];
  const terms =
    typeof obj.terms === "string" && obj.terms.trim()
      ? obj.terms.trim()
      : fallback.terms;

  return {
    title,
    summary,
    scope,
    lineItems: lineItems.length > 0 ? lineItems : fallback.lineItems,
    terms,
  };
}

/** Coerce one raw line item; drop anything without a usable description. */
function coerceLine(raw: unknown): ProposalLine | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const description =
    typeof e.description === "string" ? e.description.trim() : "";
  if (!description) return null;
  const quantity =
    typeof e.quantity === "number" &&
    Number.isFinite(e.quantity) &&
    e.quantity > 0
      ? e.quantity
      : 1;
  const unitPrice =
    typeof e.unitPrice === "number" &&
    Number.isFinite(e.unitPrice) &&
    e.unitPrice >= 0
      ? e.unitPrice
      : 0;
  return { description, quantity, unitPrice };
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

/**
 * The PDF layout script, written into the sandbox and run with Node. Reads
 * `proposal.json`, lays the quote out with `pdf-lib` (pure JS, standard Helvetica
 * — no browser, no native deps), and writes `<quoteNumber>.pdf`. Kept dependency-
 * light on purpose: the point is to show a real render in a sandbox, not to be a
 * document-design system — fork it and make the layout your own.
 */
const RENDER_SCRIPT = `import { readFileSync, writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const data = JSON.parse(readFileSync("proposal.json", "utf8"));
const { quoteNumber, currency, from = {}, client = {}, draft, totals } = data;

const money = (n) => \`\${currency} \${Number(n).toFixed(2)}\`;
const MARGIN = 56;
const PAGE = [612, 792]; // US Letter
const WIDTH = PAGE[0] - MARGIN * 2;

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

let page = pdf.addPage(PAGE);
let y = PAGE[1] - MARGIN;

function newPage() {
  page = pdf.addPage(PAGE);
  y = PAGE[1] - MARGIN;
}
function ensure(space) {
  if (y - space < MARGIN) newPage();
}
// Greedy word-wrap to the content width at the given size.
function wrap(text, f, size) {
  const words = String(text).split(/\\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line ? line + " " + w : w;
    if (f.widthOfTextAtSize(next, size) > WIDTH && line) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}
function text(str, { f = font, size = 11, gap = 4, color = rgb(0.1, 0.1, 0.1) } = {}) {
  for (const line of wrap(str, f, size)) {
    ensure(size + gap);
    page.drawText(line, { x: MARGIN, y, size, font: f, color });
    y -= size + gap;
  }
}
// A right-aligned amount on the same row as a left label.
function row(label, amount, { f = font, size = 11 } = {}) {
  ensure(size + 6);
  page.drawText(label, { x: MARGIN, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
  const w = f.widthOfTextAtSize(amount, size);
  page.drawText(amount, { x: MARGIN + WIDTH - w, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
  y -= size + 6;
}

// Header: title + quote meta.
text(draft.title || "Proposal", { f: bold, size: 22, gap: 8 });
text(\`Quote \${quoteNumber}\`, { f: bold, size: 11, gap: 2, color: rgb(0.4, 0.4, 0.4) });
if (from.company || from.name) text(\`From: \${[from.company, from.name].filter(Boolean).join(" · ")}\`, { size: 10, color: rgb(0.4, 0.4, 0.4) });
if (client.company || client.name) text(\`For: \${[client.company, client.name].filter(Boolean).join(" · ")}\`, { size: 10, color: rgb(0.4, 0.4, 0.4) });
y -= 10;

// Summary.
if (draft.summary) { text(draft.summary); y -= 6; }

// Scope.
if (Array.isArray(draft.scope) && draft.scope.length) {
  text("Scope", { f: bold, size: 13, gap: 6 });
  for (const s of draft.scope) text("•  " + s);
  y -= 6;
}

// Line items.
text("Line items", { f: bold, size: 13, gap: 8 });
for (const li of draft.lineItems || []) {
  const amount = money((li.quantity || 0) * (li.unitPrice || 0));
  const label = \`\${li.description}  (\${li.quantity} × \${money(li.unitPrice)})\`;
  // Wrap the label but keep the amount pinned to the last line.
  const lines = wrap(label, font, 11);
  for (let i = 0; i < lines.length; i++) {
    ensure(11 + 6);
    page.drawText(lines[i], { x: MARGIN, y, size: 11, font, color: rgb(0.1, 0.1, 0.1) });
    if (i === lines.length - 1) {
      const w = font.widthOfTextAtSize(amount, 11);
      page.drawText(amount, { x: MARGIN + WIDTH - w, y, size: 11, font, color: rgb(0.1, 0.1, 0.1) });
    }
    y -= 11 + 6;
  }
}
y -= 8;
row("Subtotal", money(totals.subtotal));
if (totals.tax > 0) row("Tax", money(totals.tax));
row("Total", money(totals.total), { f: bold, size: 13 });

// Terms.
if (draft.terms) { y -= 12; text("Terms", { f: bold, size: 13, gap: 6 }); text(draft.terms, { size: 10, color: rgb(0.4, 0.4, 0.4) }); }

writeFileSync(\`\${quoteNumber}.pdf\`, await pdf.save());
`;

export const agent = defineAgent<EntryInput, Shared>({
  name: "proposal-generator",
  entry: "draft",
  steps: { draft, render, review, onDecision, send, rejected },
});
