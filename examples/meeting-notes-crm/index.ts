import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import postgres from "postgres";

/**
 * Meeting-Notes → CRM Updater — turn a raw meeting transcript into a clean CRM
 * update: the fields to change on the contact, and the action items that came
 * out of the call.
 *
 * A transcript arrives two ways, from the same entry step:
 *   - **Direct / scheduled** — a run passes the notes in as `transcript` (e.g. a
 *     nightly job that hands over yesterday's calls).
 *   - **Webhook push** — with `webhook: true` and no transcript yet, the run
 *     **suspends at $0** via `pauseUntilSignal` until your note-taker (Otter,
 *     Fireflies, a Zoom hook) pushes one as the `transcript.ready` signal. No
 *     polling loop, no billed idle.
 *
 * Then, in one legible graph:
 *   intake ──▶ extract (models.run) ──▶ upsert (database) ──▶ summary (email)
 *
 *   - **extract** hands the transcript to an LLM (`ctx.sapiom.models.run` — the
 *     live x402-served model) to pull the contact it's about, the CRM fields to
 *     change (deal stage, next step), and the action items, as structured JSON.
 *   - **upsert** writes to a small Postgres CRM store the template owns. It
 *     upserts the contact row (keyed by email, falling back to company) and
 *     inserts each action item under a stable id, so the same item from a
 *     re-processed transcript is recorded once, not twice.
 *   - **summary** writes a markdown recap — fields updated, action items new vs.
 *     already tracked — and emails it to the rep. A `dryRun` (or a run with no
 *     recipient) returns the recap as a preview without touching the database or
 *     sending, so `run_local` traces the whole graph for free.
 *
 * Determinism: each step body runs once on the happy path (again only on retry).
 * Non-deterministic values — the row timestamps — are captured once at the DB
 * boundary via Postgres `now()`, not recomputed per row.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** Postgres handle the CRM store lives under — created on first run, reused after. */
const DEFAULT_DB_HANDLE = "meeting-notes-crm";
/** Vault ref holding delivery config (e.g. a default RECIPIENT). Read at runtime. */
const DELIVERY_VAULT_REF = "meeting-notes-crm";
/** Username for the inbox we send from (created once, then reused). */
const SENDER_USERNAME = "meeting-crm";
/** The named signal a note-taker fires to push a finished transcript in. */
const SIGNAL = "transcript.ready";
/** Cap the transcript the model sees — full-call transcripts can be enormous. */
const MAX_TRANSCRIPT_CHARS = 16000;
/** Cap the action items pulled from one call so cost + storage stay bounded. */
const MAX_ACTION_ITEMS = 50;

// ─────────────────────────────────────────────────────────────── shapes ──
interface EntryInput {
  /** The meeting transcript / notes to process (the direct path). */
  transcript?: string;
  /** Wait for a note-taker to push the transcript instead of passing one. */
  webhook?: boolean;
  /** Recipient email; falls back to the vault-configured default when omitted. */
  deliverTo?: string;
  /** Postgres handle for the CRM store; defaults to the template handle. */
  dbHandle?: string;
  /** When the meeting happened (ISO); defaults to now on the DB side. */
  meetingDate?: string;
  /** Compute the update but skip the DB writes and the real send. */
  dryRun?: boolean;
}

/** The transcript payload that crosses intake → extract, either path. */
interface Transcript {
  transcript: string;
}

/** Who the meeting was about, as the model returns it. */
interface Contact {
  name: string;
  email: string | null;
  company: string | null;
  title: string | null;
}

/** The CRM fields to change on the contact, as the model returns them. */
interface CrmUpdate {
  dealStage: string | null;
  nextStep: string | null;
  /** A one- or two-sentence recap of the call. */
  summary: string;
}

/** One action item as the model returns it — no id yet (derived in code). */
interface ExtractedActionItem {
  description: string;
  owner: string | null;
  dueDate: string | null;
}

/** An action item enriched with the stable id used to dedup it in the store. */
interface ActionItem extends ExtractedActionItem {
  /** Stable key for dedup — same item from a re-run must yield the same value. */
  id: string;
}

/** Everything the model pulled out of one transcript. */
interface Extraction {
  contact: Contact;
  update: CrmUpdate;
  actionItems: ExtractedActionItem[];
}

interface Shared extends Record<string, unknown> {
  dbHandle: string;
  deliverTo: string | null;
  dryRun: boolean;
  /** ISO meeting date, or null to let the DB default it to now(). */
  meetingDate: string | null;
}

type Ctx = AgentExecutionContext<Shared>;
type Sql = ReturnType<typeof postgres>;

// ─────────────────────────────────────────────────────────────── helpers ──
function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

/** Trim + bound the transcript so downstream cost stays predictable. */
function normalizeTranscript(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .slice(0, MAX_TRANSCRIPT_CHARS);
}

/** Collapse a description to a stable form for dedup (case/space-insensitive). */
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
}

/**
 * Resolve the natural CRM key for the contact — email if we have one, else a
 * company slug, else a name slug. The same contact must resolve to the same key
 * across runs so their row is updated, not duplicated.
 */
function resolveContactKey(contact: Contact): string {
  const email = contact.email?.trim().toLowerCase();
  if (email) return email;
  const slug = (contact.company || contact.name || "").trim().toLowerCase();
  const cleaned = slug.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown-contact";
}

/** Deterministic djb2 hash → hex, so an action item keys the same row every run. */
function stableId(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return `ai_${h.toString(16)}`;
}

/**
 * Resolve the recipient from the vault at runtime. A missing ref/key is an
 * expected outcome (returns null), not an error — the caller then falls back to
 * a preview. Never persisted in execution state.
 */
async function recipientFromVault(ctx: Ctx): Promise<string | null> {
  try {
    return await ctx.sapiom.vault.get(DELIVERY_VAULT_REF, "RECIPIENT");
  } catch (err) {
    ctx.logger.warn("vault: no recipient configured", { err: String(err) });
    return null;
  }
}

/** Reuse an existing inbox to send from, else provision one. */
async function resolveSenderInbox(ctx: Ctx): Promise<string> {
  const existing = await ctx.sapiom.email.inboxes.list({ limit: 1 });
  if (existing.inboxes.length > 0) return existing.inboxes[0].inboxId;
  const inbox = await ctx.sapiom.email.inboxes.create({
    username: SENDER_USERNAME,
    displayName: "Meeting Notes CRM",
  });
  return inbox.inboxId;
}

/** Open a Postgres client for a live run, or null in dryRun / when unavailable. */
async function openSql(ctx: Ctx, handle: string): Promise<Sql | null> {
  let db;
  try {
    db = await ctx.sapiom.database.get(handle);
  } catch {
    db = await ctx.sapiom.database.create({
      handle,
      duration: "7d",
      name: "Meeting Notes CRM",
      description: "Contacts + action items extracted from meeting transcripts",
    });
  }
  // `db` may be a stub (undefined) under run_local — stay null-safe and degrade.
  const conn = db?.connection?.connectionString ?? null;
  if (!conn) {
    ctx.logger.warn("database: no connection string", { handle });
    return null;
  }
  return postgres(conn, { ssl: "require" });
}

async function initSchema(sql: Sql): Promise<void> {
  await sql`
    create table if not exists crm_contacts (
      contact_key     text primary key,
      name            text,
      email           text,
      company         text,
      title           text,
      deal_stage      text,
      next_step       text,
      last_meeting_at timestamptz,
      first_seen      timestamptz not null default now(),
      updated_at      timestamptz not null default now()
    )`;
  await sql`
    create table if not exists crm_action_items (
      id           text primary key,
      contact_key  text not null,
      description  text not null,
      owner        text,
      due_date     text,
      status       text not null default 'open',
      created_at   timestamptz not null default now()
    )`;
}

// ─────────────────────────────────────────────────────────────── steps ──
const intake = defineStep({
  name: "intake",
  next: ["extract"],
  // Static graph edge: on SIGNAL, resume at `extract`. Must match the directive.
  pause: { signal: SIGNAL, resumeStep: "extract" },
  async run(input: EntryInput, ctx: Ctx) {
    ctx.shared.set("dbHandle", input.dbHandle?.trim() || DEFAULT_DB_HANDLE);
    ctx.shared.set("deliverTo", input.deliverTo?.trim() || null);
    ctx.shared.set("dryRun", truthy(input.dryRun));
    ctx.shared.set("meetingDate", input.meetingDate?.trim() || null);

    const transcript = normalizeTranscript(input.transcript);

    // Nothing passed in and asked to wait: suspend at $0 until a note-taker
    // pushes a transcript. The resumed `extract` step's input IS the payload.
    if (transcript.length === 0 && truthy(input.webhook)) {
      ctx.logger.info(
        "no transcript yet; pausing for the transcript.ready signal",
        {
          correlationId: ctx.executionId,
        },
      );
      return pauseUntilSignal({
        signal: SIGNAL,
        resumeStep: "extract",
        correlationId: ctx.executionId,
      });
    }

    return goto("extract", { transcript });
  },
});

const extract = defineStep({
  name: "extract",
  next: ["upsert"],
  // `input` is either intake's goto payload or the resumed signal payload.
  async run(input: Transcript, ctx: Ctx) {
    const transcript = normalizeTranscript(input?.transcript);

    if (transcript.length === 0) {
      ctx.logger.info("empty transcript; nothing to extract");
      return goto("upsert", { extraction: emptyExtraction() });
    }

    const system =
      "You are a sales-ops assistant reading a single meeting transcript. " +
      "Extract, as data, (1) the primary external contact the meeting was with, " +
      "(2) the CRM fields to update on them, and (3) the concrete action items " +
      "that came out of the call. Use null for anything the transcript does not " +
      "state — never guess an email or a company. Keep each action item to one " +
      "clear sentence, with an owner and a due date only when explicitly said. " +
      'Reply with ONLY minified JSON: {"contact":{"name":string,"email":string|' +
      'null,"company":string|null,"title":string|null},"update":{"dealStage":' +
      'string|null,"nextStep":string|null,"summary":string},"actionItems":' +
      '[{"description":string,"owner":string|null,"dueDate":string|null}]}.';
    const prompt = `MEETING TRANSCRIPT:\n${transcript}`;

    const res = await ctx.sapiom.models.run({ system, prompt, maxTokens: 900 });
    const extraction = parseExtraction(res.output);
    ctx.logger.info("extracted meeting notes", {
      contact: extraction.contact.name,
      actionItems: extraction.actionItems.length,
    });
    return goto("upsert", { extraction });
  },
});

const upsert = defineStep({
  name: "upsert",
  next: ["summary"],
  async run(input: { extraction: Extraction }, ctx: Ctx) {
    const extraction = input?.extraction ?? emptyExtraction();
    const dryRun = ctx.shared.get("dryRun") ?? true;
    const handle = ctx.shared.get("dbHandle") || DEFAULT_DB_HANDLE;
    const meetingDate = ctx.shared.get("meetingDate") ?? null;

    const contactKey = resolveContactKey(extraction.contact);
    const items: ActionItem[] = extraction.actionItems
      .slice(0, MAX_ACTION_ITEMS)
      .map((a) => ({
        ...a,
        id: stableId(`${contactKey}|${normalizeText(a.description)}`),
      }));

    // Dry run (or run_local's stubbed DB): treat every item as new so the graph
    // traces end to end without touching a real database.
    if (dryRun) {
      ctx.logger.info("skipping CRM store", { dryRun, items: items.length });
      return goto("summary", {
        contactKey,
        extraction,
        newItems: items,
        existingItems: [] as ActionItem[],
      });
    }

    const sql = await openSql(ctx, handle);
    if (!sql) {
      // No DB available — degrade to "everything new" rather than abort.
      return goto("summary", {
        contactKey,
        extraction,
        newItems: items,
        existingItems: [] as ActionItem[],
      });
    }

    try {
      await initSchema(sql);
      const { contact, update } = extraction;

      // Upsert the contact — coalesce keeps a prior non-null value when this
      // transcript didn't restate it, so a partial call never wipes a field.
      await sql`
        insert into crm_contacts
          (contact_key, name, email, company, title, deal_stage, next_step, last_meeting_at)
        values
          (${contactKey}, ${contact.name}, ${contact.email}, ${contact.company},
           ${contact.title}, ${update.dealStage}, ${update.nextStep},
           coalesce(${meetingDate}::timestamptz, now()))
        on conflict (contact_key) do update set
          name            = coalesce(excluded.name, crm_contacts.name),
          email           = coalesce(excluded.email, crm_contacts.email),
          company         = coalesce(excluded.company, crm_contacts.company),
          title           = coalesce(excluded.title, crm_contacts.title),
          deal_stage      = coalesce(excluded.deal_stage, crm_contacts.deal_stage),
          next_step       = coalesce(excluded.next_step, crm_contacts.next_step),
          last_meeting_at = excluded.last_meeting_at,
          updated_at      = now()`;

      const newItems: ActionItem[] = [];
      const existingItems: ActionItem[] = [];
      for (const item of items) {
        const prior = await sql<{ id: string }[]>`
          select id from crm_action_items where id = ${item.id}`;
        if (prior.length === 0) {
          newItems.push(item);
        } else {
          existingItems.push(item);
        }
        await sql`
          insert into crm_action_items (id, contact_key, description, owner, due_date)
          values (${item.id}, ${contactKey}, ${item.description}, ${item.owner}, ${item.dueDate})
          on conflict (id) do nothing`;
      }

      ctx.logger.info("wrote CRM update", {
        contactKey,
        new: newItems.length,
        existing: existingItems.length,
      });
      return goto("summary", {
        contactKey,
        extraction,
        newItems,
        existingItems,
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
});

const summary = defineStep({
  name: "summary",
  next: [],
  terminal: true,
  async run(
    input: {
      contactKey: string;
      extraction: Extraction;
      newItems: ActionItem[];
      existingItems: ActionItem[];
    },
    ctx: Ctx,
  ) {
    const extraction = input?.extraction ?? emptyExtraction();
    const newItems = Array.isArray(input?.newItems) ? input.newItems : [];
    const existingItems = Array.isArray(input?.existingItems)
      ? input.existingItems
      : [];
    const dryRun = ctx.shared.get("dryRun") ?? true;

    const body = renderSummary(extraction, newItems, existingItems);
    const who =
      extraction.contact.company || extraction.contact.name || "the contact";
    const subject = `CRM updated: ${who} — ${newItems.length} new action item(s)`;

    // Explicit input wins; otherwise resolve the default from the vault at
    // runtime (never carried through state).
    const deliverTo =
      ctx.shared.get("deliverTo") || (await recipientFromVault(ctx));

    // Safe path: a dry run, or a live run with no recipient, returns the recap
    // without sending anything.
    if (dryRun || !deliverTo) {
      ctx.logger.info("skipping delivery", {
        dryRun,
        hasRecipient: Boolean(deliverTo),
      });
      return terminate({
        delivered: false,
        dryRun,
        reason: dryRun ? "dry-run" : "no-recipient",
        to: deliverTo ?? null,
        subject,
        summary: body,
        contact: extraction.contact,
        newCount: newItems.length,
        existingCount: existingItems.length,
      });
    }

    const inboxId = await resolveSenderInbox(ctx);
    const sent = await ctx.sapiom.email.messages.send(inboxId, {
      to: deliverTo,
      subject,
      text: body,
    });
    ctx.logger.info("summary delivered", {
      to: deliverTo,
      messageId: sent.messageId,
    });
    return terminate({
      delivered: true,
      dryRun: false,
      to: deliverTo,
      subject,
      messageId: sent.messageId,
      contact: extraction.contact,
      newCount: newItems.length,
      existingCount: existingItems.length,
    });
  },
});

// ─────────────────────────────────────────────────────────────── render ──
function renderItem(item: ActionItem): string {
  const meta = [item.owner, item.dueDate ? `due ${item.dueDate}` : null]
    .filter(Boolean)
    .join(", ");
  return `- ${item.description}${meta ? ` _(${meta})_` : ""}`;
}

function renderSummary(
  extraction: Extraction,
  newItems: ActionItem[],
  existingItems: ActionItem[],
): string {
  const { contact, update } = extraction;
  const heading = [contact.title, contact.company].filter(Boolean).join(", ");
  const lines = [
    `# Meeting notes → CRM`,
    ``,
    `**Contact:** ${contact.name}${heading ? ` — ${heading}` : ""}` +
      `${contact.email ? ` <${contact.email}>` : ""}`,
    `**Deal stage:** ${update.dealStage ?? "_unchanged_"}`,
    `**Next step:** ${update.nextStep ?? "_none noted_"}`,
    ``,
    update.summary || "_No recap produced._",
    ``,
    `## Action items (${newItems.length} new, ${existingItems.length} already tracked)`,
  ];
  lines.push(`### New (${newItems.length})`);
  lines.push(
    newItems.length === 0
      ? `_None — nothing new from this call._`
      : newItems.map(renderItem).join("\n"),
  );
  lines.push(``);
  lines.push(`### Already tracked (${existingItems.length})`);
  lines.push(
    existingItems.length === 0
      ? `_None._`
      : existingItems.map(renderItem).join("\n"),
  );
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────── parsing ──
/** A minimal, valid extraction for the empty / unparseable path. */
function emptyExtraction(): Extraction {
  return {
    contact: {
      name: "Unknown contact",
      email: null,
      company: null,
      title: null,
    },
    update: { dealStage: null, nextStep: null, summary: "" },
    actionItems: [],
  };
}

/** Extract the structured update from model output; fall back to empty. */
function parseExtraction(output: string | null): Extraction {
  if (!output) return emptyExtraction();
  try {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start < 0 || end < 0) return emptyExtraction();
    const parsed = JSON.parse(output.slice(start, end + 1)) as {
      contact?: unknown;
      update?: unknown;
      actionItems?: unknown;
    };
    return {
      contact: coerceContact(parsed.contact),
      update: coerceUpdate(parsed.update),
      actionItems: Array.isArray(parsed.actionItems)
        ? parsed.actionItems
            .map(coerceActionItem)
            .filter((a): a is ExtractedActionItem => a !== null)
        : [],
    };
  } catch {
    return emptyExtraction();
  }
}

/** null-safe string: trims and returns null for empty/absent values. */
function nullableStr(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s.length > 0 ? s : null;
}

function coerceContact(raw: unknown): Contact {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    name: nullableStr(r.name) ?? "Unknown contact",
    email: nullableStr(r.email),
    company: nullableStr(r.company),
    title: nullableStr(r.title),
  };
}

function coerceUpdate(raw: unknown): CrmUpdate {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    dealStage: nullableStr(r.dealStage),
    nextStep: nullableStr(r.nextStep),
    summary: nullableStr(r.summary) ?? "",
  };
}

function coerceActionItem(raw: unknown): ExtractedActionItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const description = nullableStr(r.description);
  if (!description) return null;
  return {
    description,
    owner: nullableStr(r.owner),
    dueDate: nullableStr(r.dueDate),
  };
}

export const agent = defineAgent<EntryInput, Shared>({
  name: "meeting-notes-crm",
  entry: "intake",
  steps: { intake, extract, upsert, summary },
});
