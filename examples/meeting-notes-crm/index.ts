import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  resolveResourceHandle,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { EmailHttpError } from "@sapiom/tools";
import postgres from "postgres";
import { z } from "zod/v4";

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
 *   intake ──▶ extract (llm.run) ──▶ upsert (database) ──▶ summary (email)
 *
 *   - **extract** hands the transcript to an LLM (`ctx.sapiom.llm.run` — the
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
/**
 * The transcript a zero-input run extracts from. A real one, because the whole
 * artifact is what the model pulls out of it — an empty transcript produces an
 * empty contact and an empty action list, which is a successful-looking run that
 * did nothing.
 */
const SAMPLE_TRANSCRIPT =
  "Call with Dana Ruiz, VP Eng at Northwind. She confirmed budget for the Q3 " +
  "rollout and wants a security review before signing. I'll send the SOC 2 " +
  "report by Friday and Dana will loop in their CISO next week. Deal looks like " +
  "it's moving to contract stage.";
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
  /** Recipient email. Omit it and the recap is returned inline instead of emailed. */
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
  /** Set when the run extracted from the built-in sample transcript. */
  note?: string;
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
 * Reuse an existing inbox to send from, else provision one.
 *
 * We deliberately omit `username`. AgentMail addresses are globally unique, so a
 * fixed local part can only ever be owned by ONE account across the whole
 * platform — every other tenant's `create` 409s with "Email address is already
 * taken", which fails the step. Omitting it lets AgentMail auto-generate a
 * globally-unique address, so a fresh tenant's first run succeeds and two
 * tenants never collide. `create` still isn't atomic against the `list`, so a
 * 409 is treated as "someone already provisioned one" — re-list and reuse.
 */
async function resolveSenderInbox(ctx: Ctx): Promise<string> {
  const existing = await ctx.sapiom.email.inboxes.list({ limit: 1 });
  if (existing.inboxes.length > 0) return existing.inboxes[0].inboxId;
  try {
    const inbox = await ctx.sapiom.email.inboxes.create({
      displayName: "Meeting Notes CRM",
    });
    return inbox.inboxId;
  } catch (err) {
    if (err instanceof EmailHttpError && err.status === 409) {
      const retry = await ctx.sapiom.email.inboxes.list({ limit: 1 });
      if (retry.inboxes.length > 0) return retry.inboxes[0].inboxId;
    }
    throw err;
  }
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
/**
 * The entry contract — this agent's public API, and what the dashboard "Run
 * once" form renders its labelled fields from. Every field is optional: pass a
 * `transcript` directly, or set `webhook` to wait for a note-taker to push one.
 */
const entryInput = z.object({
  transcript: z
    .string()
    .optional()
    .describe("The meeting transcript / notes to process (the direct path)."),
  webhook: z
    .boolean()
    .optional()
    .describe(
      "Wait for a note-taker to push the transcript instead of passing one.",
    ),
  deliverTo: z
    .string()
    .optional()
    .describe(
      "Recipient email. Omit it and the recap is returned inline instead of emailed.",
    ),
  dbHandle: z
    .string()
    .optional()
    .describe(
      "Postgres handle for the CRM store; defaults to the template handle.",
    ),
  meetingDate: z
    .string()
    .optional()
    .describe(
      "When the meeting happened (ISO); defaults to now on the DB side.",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe("Compute the update but skip the DB writes and the real send."),
});

const intake = defineStep({
  name: "intake",
  inputSchema: entryInput,
  next: ["extract"],
  // Static graph edge: on SIGNAL, resume at `extract`. Must match the directive.
  pause: { signal: SIGNAL, resumeStep: "extract" },
  async run(input: EntryInput, ctx: Ctx) {
    ctx.shared.set(
      "dbHandle",
      resolveResourceHandle(input, { fallback: DEFAULT_DB_HANDLE }),
    );
    ctx.shared.set("deliverTo", input.deliverTo?.trim() || null);
    ctx.shared.set("dryRun", truthy(input.dryRun));
    ctx.shared.set("meetingDate", input.meetingDate?.trim() || null);

    let transcript = normalizeTranscript(input.transcript);

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

    // Nothing passed in and nobody is going to push one: extract from the sample
    // transcript so the run produces a real contact and real action items, and
    // say in the output that the transcript was ours.
    if (transcript.length === 0) {
      transcript = normalizeTranscript(SAMPLE_TRANSCRIPT);
      ctx.shared.set(
        "note",
        "Extracted from the built-in sample transcript. Pass your own `transcript`, or set `webhook: true` to wait for one.",
      );
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
      "clear sentence, with an owner and a due date only when explicitly said.";
    const prompt = `MEETING TRANSCRIPT:\n${transcript}`;

    const res = await ctx.sapiom.llm.run({
      request: {
        system,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 900,
      },
      output: { name: EXTRACT_TOOL, schema: EXTRACT_SCHEMA },
    });
    const extraction = readExtraction(
      ctx.sapiom.llm.structuredOf(res, EXTRACT_TOOL),
    );
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

    // A recipient is ordinary configuration, so it arrives as run input (declared
    // as a `deliverTo` setting in template.json) rather than from a write-only
    // secret store nothing in the product can populate.
    const deliverTo = ctx.shared.get("deliverTo");

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
        ...(dryRun ? {} : { unmet: ["deliverTo"] }),
        note: [
          dryRun
            ? "`dryRun` was set, so nothing was emailed and nothing was written to the CRM table."
            : "Nothing was emailed: no `deliverTo` address is set, so the recap is returned inline below.",
          ctx.shared.get("note"),
        ]
          .filter(Boolean)
          .join(" "),
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
      ...(ctx.shared.get("note") ? { note: ctx.shared.get("note") } : {}),
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

// ────────────────────────────────────────────────────── structured output ──
/**
 * The extraction for a transcript with no model call in it — an empty
 * transcript. Reached only on that path; it is NOT a stand-in for a model that
 * failed to answer, which is what `parseExtraction` used to return so that
 * "the reply was unparseable" and "the meeting had no content" wrote the same
 * row to the CRM.
 */
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

/**
 * The forced tool call `extract` reads the meeting's data out of. `llm.run`'s
 * `output` appends this tool to the request and pins `tool_choice` to it, so the
 * extraction arrives as a typed `tool_use` block — there is no prose to slice
 * and no JSON to hand-parse.
 */
const EXTRACT_TOOL = "emit_extraction";

const NULLABLE_STRING = { type: ["string", "null"] as const };

const EXTRACT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    contact: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The primary external contact the meeting was with.",
        },
        email: NULLABLE_STRING,
        company: NULLABLE_STRING,
        title: NULLABLE_STRING,
      },
      required: ["name", "email", "company", "title"],
      additionalProperties: false,
      description:
        "Use null for anything the transcript does not state — never guess an email or a company.",
    },
    update: {
      type: "object",
      properties: {
        dealStage: NULLABLE_STRING,
        nextStep: NULLABLE_STRING,
        summary: {
          type: "string",
          description: "A one- or two-sentence recap of the call.",
        },
      },
      required: ["dealStage", "nextStep", "summary"],
      additionalProperties: false,
    },
    actionItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "One clear sentence.",
          },
          owner: NULLABLE_STRING,
          dueDate: NULLABLE_STRING,
        },
        required: ["description", "owner", "dueDate"],
        additionalProperties: false,
      },
      description:
        "The concrete action items from the call. An owner or due date only when explicitly said.",
    },
  },
  required: ["contact", "update", "actionItems"],
  additionalProperties: false,
};

/**
 * Read the forced tool call back into an `Extraction`.
 *
 * Throws when the model returned no such block, or one with no contact or
 * `update` object. This extraction is written to the CRM and emailed as a
 * meeting recap, so a silent empty one was not a graceful degradation: it filed
 * `"Unknown contact"` with no action items against a real call, indistinguishable
 * from a meeting where genuinely nothing was agreed.
 *
 * An empty `actionItems` list stays a real answer — plenty of calls produce
 * none — but it has to be a list the model actually returned.
 */
export function readExtraction(structured: unknown): Extraction {
  if (structured === null || typeof structured !== "object") {
    throw new Error(
      "extract: the model returned no structured extraction — refusing to write an invented CRM row.",
    );
  }
  const parsed = structured as {
    contact?: unknown;
    update?: unknown;
    actionItems?: unknown;
  };
  if (parsed.contact === null || typeof parsed.contact !== "object") {
    throw new Error(
      "extract: the model returned no contact — refusing to file the call against an invented one.",
    );
  }
  if (parsed.update === null || typeof parsed.update !== "object") {
    throw new Error(
      "extract: the model returned no CRM update — refusing to invent one.",
    );
  }
  if (!Array.isArray(parsed.actionItems)) {
    throw new Error(
      "extract: the model returned no action-item list — refusing to report the call as having none.",
    );
  }
  return {
    contact: coerceContact(parsed.contact),
    update: coerceUpdate(parsed.update),
    actionItems: parsed.actionItems
      .map(coerceActionItem)
      .filter((a): a is ExtractedActionItem => a !== null),
  };
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
