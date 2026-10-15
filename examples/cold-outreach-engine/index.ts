import {
  defineAgent,
  defineStep,
  fail,
  goto,
  resolveResourceHandle,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { EmailHttpError } from "@sapiom/tools";
import postgres from "postgres";
import { z } from "zod/v4";

/**
 * Opt-in Lead Follow-up — write a personalized first email to every person who
 * asked to hear from you (a demo request, a waitlist sign-up, a contact form),
 * then send a short follow-up sequence on a schedule that stops for anyone who
 * replies.
 *
 *   intake ─▶ scrape (web) ─▶ personalize (llm.run) ─▶ verify (email) ─▶ enroll (database)
 *      └──────────────────────────────────────────────────────────────────────┴─▶ send (email)
 *
 *   - **intake** takes the contacts you collected. Every contact must carry an
 *     `optInSource` — where they asked to hear from you. A contact without one
 *     is rejected and listed in the output; this template does not find or
 *     write to strangers.
 *   - **scrape** reads each contact's company site (`web.scrape`) for a few
 *     lines of context. The bodies are bounded and die at the next step.
 *   - **personalize** hands those snippets to the live model (`llm.run`) for one
 *     concrete first line per contact. A contact the model wrote nothing for is
 *     not emailed.
 *   - **verify** checks each address for deliverability (`verifyEmail`) and
 *     drops the ones that would bounce — sign-up forms collect typos.
 *   - **enroll** adds the deliverable contacts to the campaign roster in a
 *     Postgres store the agent owns. A `dryRun` stops here and returns the plan.
 *   - **send** works the whole roster once: it sends the first touch to anyone
 *     newly enrolled and, for everyone else, checks their thread for a reply and
 *     sends the next touch when it is due. Every send failure is in the output.
 *
 * Follow-ups come from a schedule, not a pause. Attach a cron trigger that runs
 * this agent with `{ "campaign": "<name>" }`; each run is one pass over the
 * roster and ends. There is no paused run waiting out the interval: a pause
 * timeout fails the run on Sapiom rather than resuming it, so a wait-then-send
 * loop built on one would stop after the first touch.
 *
 * Replies: before each follow-up, `send` reads the contact's thread
 * (`email.threads.get`). Any message in it from someone other than the sending
 * inbox ends that contact's sequence. Later touches go out as replies in the
 * first touch's thread, so the reply check sees every answer.
 *
 * Zero-setup demo: with no `contacts` and no `campaign`, the run works
 * `DEMO_CONTACTS` — three fabricated opt-ins — instead of stopping with nobody
 * to write to. `scrape` uses each one's canned blurb and `verify` treats it as
 * deliverable; `personalize` still calls the live model, `enroll` still writes
 * to the database, and `send` still delivers the first touch — to this agent's
 * own Sapiom-hosted inbox (`resolveSenderInbox`), never to the fabricated
 * address. Demo contacts are stored as `demo`, so no scheduled pass ever
 * follows them up.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** Postgres handle the agent owns — created on first run, reused after. */
const DEFAULT_DB_HANDLE = "cold-outreach-engine";
/** Campaign a run works when it names none. */
const DEFAULT_CAMPAIGN = "opt-in-follow-up";
/** Campaign the zero-setup demo writes under — never worked by a schedule. */
const DEMO_CAMPAIGN = "__zero-setup-demo__";
/** Cap the new contacts per run so cost + latency stay bounded. */
const MAX_CONTACTS = 25;
/** Truncate each scraped body — the ONLY large data on the scrape→personalize path. */
const MAX_CONTEXT_CHARS = 1500;
/** Days between touches when the caller doesn't pass one. */
const DEFAULT_DRIP_DAYS = 3;
/** Below this verification confidence score, treat an address as undeliverable. */
const VERIFY_MIN_SCORE = 50;
/** Default cadence documented for the cron trigger: 09:00 on weekdays. */
const DEFAULT_SCHEDULE = "0 9 * * 1-5";
/** Milliseconds in a day — drip interval math. */
const DAY_MS = 24 * 60 * 60 * 1000;
/** Mailbox providers whose domain says nothing about the contact's company. */
const PERSONAL_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
]);

// ─────────────────────────────────────────────────────────────── shapes ──
/** One person who asked to hear from you. */
interface OptInContact {
  /** Their address. Required. */
  email: string;
  /** Where they asked to hear from you, e.g. "demo request form". Required. */
  optInSource: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  position?: string;
  company?: string;
  /** Company site to read for context; defaults to the email's domain. */
  domain?: string;
}

/** One touch in the sequence. Tokens: {firstName} {company} {sender}. */
interface Touch {
  /** Used by the first touch only — later touches reply in its thread. */
  subject: string;
  body: string;
}

interface EntryInput {
  /** New opt-in contacts to enroll on this run. Partial: `intake` rejects incomplete ones individually. */
  contacts?: Partial<OptInContact>[];
  /** Campaign name — the roster key. A scheduled pass passes only this. */
  campaign?: string;
  /** The sequence; defaults to a three-touch sequence. */
  sequence?: Touch[];
  /** Days between touches (default 3). */
  dripIntervalDays?: number;
  /** Display name signed on the outgoing mail. */
  senderName?: string;
  /** Inbox to send from. Use one on your own domain to reach outside your org. */
  inboxId?: string;
  /** Cron cadence this agent is meant to run on (documentation only). */
  schedule?: string;
  /** Postgres handle for the campaign store; defaults to the template handle. */
  dbHandle?: string;
  /** Compute the plan and openers but skip the send and the DB. */
  dryRun?: boolean;
}

/** A contact as it moves through the run. */
interface Contact {
  email: string;
  optInSource?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  position?: string;
  company?: string;
  domain?: string;
  /** The personalized opener (added by `personalize`). */
  firstLine?: string;
  /** Whether the address cleared verification (added by `verify`). */
  deliverable?: boolean;
  /** The verification verdict, for the summary (added by `verify`). */
  verifyStatus?: string;
  /** Roster state: "active" until it replies or the sequence ends. */
  status?: "active" | "replied" | "done" | "demo";
  /** Touches sent to this contact so far, across every run. */
  touchesSent?: number;
  /** Set on the built-in zero-setup batch — see `DEMO_CONTACTS`. */
  demo?: boolean;
}

/** A contact the run could not use, and why. */
interface Rejected {
  email: string | null;
  reason: string;
}

/** A send (or reply check) that failed, as it appears in the run output. */
interface SendFailure {
  email: string;
  touch: number;
  /** HTTP status from the email capability, when it returned one. */
  status: number | null;
  /** Machine-readable code from the error body, e.g. `recipient_not_allowed`. */
  code: string | null;
  error: string;
}

/** The fields a run passed explicitly; they overwrite the stored campaign config. */
interface ConfigOverrides {
  sequence?: Touch[];
  dripMs?: number;
  senderName?: string;
  inboxId?: string;
}

interface Shared extends Record<string, unknown> {
  campaign: string;
  dbHandle: string;
  dryRun: boolean;
  demoRun: boolean;
  schedule: string;
  overrides: ConfigOverrides;
  rejected: Rejected[];
  /** Read by the dashboard: the contacts this run worked, with their state. */
  contacts: Contact[];
  sequence: Touch[];
  senderName: string;
  dripMs: number;
}

type Ctx = AgentExecutionContext<Shared>;
type Sql = ReturnType<typeof postgres>;

/** One fabricated opt-in in the built-in zero-setup batch. */
interface DemoContact {
  /** `.example` — reserved (RFC 2606), never resolves, never a real inbox. */
  domain: string;
  company: string;
  firstName: string;
  lastName: string;
  position: string;
  /** Never dialed; `send` targets this agent's own inbox instead. */
  email: string;
  optInSource: string;
  /** A canned company blurb standing in for the page `scrape` would read. */
  context: string;
}

/**
 * The zero-setup stand-in: three fabricated opt-ins, used only when a run
 * names no `contacts` and no `campaign`. `.example` sites don't resolve and
 * `.example` addresses can't be verified, so `scrape` and `verify` use canned
 * stand-ins; `personalize`, `enroll`, and `send` run for real. See "Make it
 * runnable with nothing" in AUTHORING.md.
 */
const DEMO_CONTACTS: DemoContact[] = [
  {
    domain: "brightloop.example",
    company: "Brightloop",
    firstName: "Jordan",
    lastName: "Rivera",
    position: "Head of Growth",
    email: "jordan.rivera@brightloop.example",
    optInSource: "demo request form",
    context:
      "Brightloop sells shift-scheduling software to retail chains. Their site " +
      "leads with a case study: a 40-store grocery chain cut no-show shifts by " +
      "a third in one quarter.",
  },
  {
    domain: "fernwoodlabs.example",
    company: "Fernwood Labs",
    firstName: "Priya",
    lastName: "Nandan",
    position: "VP of Engineering",
    email: "priya.nandan@fernwoodlabs.example",
    optInSource: "webinar sign-up",
    context:
      "Fernwood Labs builds lab-inventory tracking for biotech startups. They " +
      "just announced a partnership with a reagent supplier to auto-reorder " +
      "stock that falls below threshold.",
  },
  {
    domain: "haventree.example",
    company: "Haventree",
    firstName: "Marcus",
    lastName: "Webb",
    position: "Director of Operations",
    email: "marcus.webb@haventree.example",
    optInSource: "pricing page contact form",
    context:
      "Haventree runs a network of urgent-care clinics. Their homepage " +
      "highlights a new online check-in flow that cut waiting-room time in half.",
  },
];

/** The three-touch default — a personalized first email, a nudge, and a last note. */
const DEFAULT_SEQUENCE: Touch[] = [
  {
    subject: "Following up on your request, {firstName}",
    body: "Happy to set up a short call, or send over a few notes first if that's easier. Just reply with what works.\n\nIf you'd rather not hear from me, reply and I'll stop.\n\nBest,\n{sender}",
  },
  {
    subject: "Re: Following up on your request, {firstName}",
    body: "Checking in once in case my last note got buried. Still glad to walk through anything for {company} whenever the timing's right.\n\nBest,\n{sender}",
  },
  {
    subject: "Last note, {firstName}",
    body: "I'll leave it here so I'm not cluttering your inbox. If it becomes a priority for {company} later, just reply and I'll pick it back up.\n\nAll the best,\n{sender}",
  },
];

// ─────────────────────────────────────────────────────────────── helpers ──
function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

/** Fill {firstName} / {company} / {sender} tokens with sensible fallbacks. */
function render(template: string, contact: Contact, sender: string): string {
  return template
    .replaceAll("{firstName}", contact.firstName?.trim() || "there")
    .replaceAll("{lastName}", contact.lastName?.trim() || "")
    .replaceAll(
      "{fullName}",
      contact.fullName?.trim() || contact.firstName?.trim() || "there",
    )
    .replaceAll("{company}", contact.company?.trim() || "your team")
    .replaceAll("{sender}", sender);
}

/** The bare address out of `Name <addr>` or `addr`, lowercased. */
export function addressOf(from: string): string {
  // String scanning rather than a regex: `from` is a header off inbound mail.
  const lt = from.lastIndexOf("<");
  const gt = lt >= 0 ? from.indexOf(">", lt) : -1;
  const addr = gt > lt + 1 ? from.slice(lt + 1, gt) : from;
  return addr.trim().toLowerCase();
}

/** `local@domain.tld` with no whitespace — enough to reject a typo'd field. */
export function looksLikeEmail(value: string): boolean {
  if (/\s/.test(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return domain[0] !== "." && dot > 0 && dot < domain.length - 1;
}

/**
 * Split the supplied contacts into usable ones and rejects. A contact needs a
 * plausible address and a non-empty `optInSource`: the source is the record
 * that this person asked to be contacted, and without it the template has no
 * business emailing them.
 */
export function normalizeContacts(raw: unknown): {
  contacts: Contact[];
  rejected: Rejected[];
} {
  const contacts: Contact[] = [];
  const rejected: Rejected[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw)) return { contacts, rejected };
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      rejected.push({ email: null, reason: "not an object" });
      continue;
    }
    const r = entry as Record<string, unknown>;
    const str = (k: string) =>
      typeof r[k] === "string" && (r[k] as string).trim()
        ? (r[k] as string).trim()
        : undefined;
    const email = str("email")?.toLowerCase();
    if (!email || !looksLikeEmail(email)) {
      rejected.push({
        email: email ?? null,
        reason: "missing or invalid email",
      });
      continue;
    }
    const optInSource = str("optInSource");
    if (!optInSource) {
      rejected.push({
        email,
        reason:
          "missing optInSource — only contacts who asked to hear from you are emailed",
      });
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    if (contacts.length >= MAX_CONTACTS) {
      rejected.push({
        email,
        reason: `over the ${MAX_CONTACTS}-contact limit per run`,
      });
      continue;
    }
    const mailDomain = email.split("@")[1];
    contacts.push({
      email,
      optInSource,
      fullName: str("fullName"),
      firstName: str("firstName") ?? str("fullName")?.split(/\s+/)[0],
      lastName: str("lastName"),
      position: str("position"),
      company: str("company"),
      domain:
        str("domain") ??
        (PERSONAL_MAIL_DOMAINS.has(mailDomain) ? undefined : mailDomain),
      status: "active",
      touchesSent: 0,
    });
  }
  return { contacts, rejected };
}

/** Turn a thrown send error into the shape the run output reports. */
function toFailure(email: string, touch: number, err: unknown): SendFailure {
  if (err instanceof EmailHttpError) {
    const body = err.body as Record<string, unknown> | null;
    const code =
      body && typeof body === "object"
        ? ([body.code, body.error, body.name].find(
            (v): v is string => typeof v === "string",
          ) ?? null)
        : null;
    return { email, touch, status: err.status, code, error: err.message };
  }
  return { email, touch, status: null, code: null, error: String(err) };
}

/** Open a Postgres client, or null when the database is unavailable. */
async function openSql(ctx: Ctx, handle: string): Promise<Sql | null> {
  try {
    let db;
    try {
      db = await ctx.sapiom.database.get(handle);
    } catch {
      db = await ctx.sapiom.database.create({
        handle,
        name: "Opt-in Lead Follow-up",
        description: "Campaign roster, sent touches, and reply state",
      });
    }
    const conn = db.connection?.connectionString ?? null;
    if (!conn) {
      ctx.logger.warn("database: no connection string", { handle });
      return null;
    }
    // One connection, so the session-level advisory lock `send` takes holds
    // for every query it makes.
    return postgres(conn, { ssl: "require", connect_timeout: 10, max: 1 });
  } catch (err) {
    ctx.logger.warn("database: unavailable", { err: String(err) });
    return null;
  }
}

async function initSchema(sql: Sql): Promise<void> {
  await sql`
    create table if not exists outreach_campaigns (
      campaign     text primary key,
      sequence     jsonb not null,
      drip_ms      bigint not null,
      sender_name  text not null,
      inbox_id     text,
      updated_at   timestamptz not null default now()
    )`;
  await sql`
    create table if not exists outreach_contacts (
      campaign     text not null,
      email        text not null,
      full_name    text,
      company      text,
      position     text,
      first_line   text,
      status       text not null default 'active',
      replied_at   timestamptz,
      created_at   timestamptz not null default now(),
      primary key (campaign, email)
    )`;
  // Columns added when the template moved from a paused drip to scheduled
  // passes; `add column if not exists` upgrades a roster an older version made.
  await sql`alter table outreach_contacts add column if not exists opt_in_source text`;
  await sql`alter table outreach_contacts add column if not exists first_name text`;
  await sql`alter table outreach_contacts add column if not exists touches_sent integer not null default 0`;
  await sql`alter table outreach_contacts add column if not exists last_sent_at timestamptz`;
  await sql`alter table outreach_contacts add column if not exists thread_id text`;
  await sql`alter table outreach_contacts add column if not exists last_message_id text`;
  // The inbox a contact's thread lives in. Changing the campaign's `inboxId`
  // later must not strand threads the old inbox started.
  await sql`alter table outreach_contacts add column if not exists inbox_id text`;
  await sql`
    create table if not exists outreach_touches (
      id           bigserial primary key,
      campaign     text not null,
      email        text not null,
      touch_index  integer not null,
      subject      text,
      message_id   text,
      sent_at      timestamptz not null default now()
    )`;
}

/**
 * Reuse an existing inbox to send from, else provision one.
 *
 * We deliberately omit `username`. AgentMail addresses are globally unique, so a
 * fixed local part can only ever be owned by ONE account across the whole
 * platform — every other tenant's `create` 409s with "Email address is already
 * taken", which fails the step. Omitting it lets AgentMail auto-generate a
 * globally-unique address. `create` still isn't atomic against the `list`, so a
 * 409 is treated as "someone already provisioned one" — re-list and reuse.
 *
 * A free `sapiom.email` inbox only delivers inside your own organization; a
 * send to anyone else fails with 403 `recipient_not_allowed`. To reach real
 * contacts, pass `inboxId` for an inbox on your own domain.
 */
async function resolveSenderInbox(
  ctx: Ctx,
  displayName: string,
): Promise<string> {
  const existing = await ctx.sapiom.email.inboxes.list({ limit: 1 });
  if (existing.inboxes.length > 0) return existing.inboxes[0].inboxId;
  try {
    const inbox = await ctx.sapiom.email.inboxes.create({ displayName });
    return inbox.inboxId;
  } catch (err) {
    if (err instanceof EmailHttpError && err.status === 409) {
      const retry = await ctx.sapiom.email.inboxes.list({ limit: 1 });
      if (retry.inboxes.length > 0) return retry.inboxes[0].inboxId;
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────── steps ──
/**
 * The entry contract — this agent's public API, and what the dashboard "Run
 * once" form renders its labelled fields from. Every field is optional: a
 * zero-input run works the built-in demo batch.
 */
const entryInput = z.object({
  contacts: z
    .array(
      z.object({
        // Required, but checked per contact in `intake`: a schema failure here
        // would reject the whole batch instead of just the incomplete entry.
        email: z.string().optional(),
        optInSource: z.string().optional(),
        fullName: z.string().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        position: z.string().optional(),
        company: z.string().optional(),
        domain: z.string().optional(),
      }),
    )
    .optional()
    .describe(
      "People who asked to hear from you. Each needs an email and an optInSource.",
    ),
  campaign: z
    .string()
    .optional()
    .describe(
      "Campaign name — the roster key. A scheduled follow-up run passes only this.",
    ),
  sequence: z
    .array(z.object({ subject: z.string(), body: z.string() }))
    .optional()
    .describe("The sequence; defaults to three touches."),
  dripIntervalDays: z
    .number()
    .optional()
    .describe("Days between touches (default 3)."),
  senderName: z
    .string()
    .optional()
    .describe("Display name signed on the outgoing mail."),
  inboxId: z
    .string()
    .optional()
    .describe(
      "Inbox to send from. Use one on your own domain to reach people outside your organization.",
    ),
  schedule: z
    .string()
    .optional()
    .describe("Cron cadence this agent runs on (documentation only)."),
  dbHandle: z
    .string()
    .optional()
    .describe(
      "Postgres handle for the campaign store; defaults to the template handle.",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe("Compute the plan and openers but skip the send and the DB."),
});

const intake = defineStep({
  name: "intake",
  inputSchema: entryInput,
  next: ["scrape", "send"],
  // Terminal too: a dry run with no new contacts has nothing to plan.
  terminal: true,
  async run(input: EntryInput, ctx: Ctx) {
    const supplied = Array.isArray(input.contacts) && input.contacts.length > 0;
    const named = Boolean(input.campaign?.trim());
    // Zero-setup: nothing supplied and no campaign to work. A run that names a
    // campaign but brings no contacts is a scheduled follow-up pass, not a demo.
    const demoRun = !supplied && !named;
    const dryRun = truthy(input.dryRun);

    const overrides: ConfigOverrides = {};
    if (Array.isArray(input.sequence) && input.sequence.length > 0) {
      overrides.sequence = input.sequence;
    }
    if (Number(input.dripIntervalDays) > 0) {
      overrides.dripMs = Number(input.dripIntervalDays) * DAY_MS;
    }
    if (input.senderName?.trim())
      overrides.senderName = input.senderName.trim();
    if (input.inboxId?.trim()) overrides.inboxId = input.inboxId.trim();

    ctx.shared.set(
      "campaign",
      demoRun ? DEMO_CAMPAIGN : input.campaign?.trim() || DEFAULT_CAMPAIGN,
    );
    ctx.shared.set(
      "dbHandle",
      resolveResourceHandle(input, { fallback: DEFAULT_DB_HANDLE }),
    );
    ctx.shared.set("dryRun", dryRun);
    ctx.shared.set("demoRun", demoRun);
    ctx.shared.set("schedule", input.schedule?.trim() || DEFAULT_SCHEDULE);
    ctx.shared.set("overrides", overrides);
    ctx.shared.set("sequence", overrides.sequence ?? DEFAULT_SEQUENCE);
    ctx.shared.set("senderName", overrides.senderName ?? "The team");
    ctx.shared.set("dripMs", overrides.dripMs ?? DEFAULT_DRIP_DAYS * DAY_MS);

    if (demoRun) {
      const contacts: Contact[] = DEMO_CONTACTS.map((d) => ({
        email: d.email,
        optInSource: d.optInSource,
        firstName: d.firstName,
        lastName: d.lastName,
        fullName: `${d.firstName} ${d.lastName}`,
        position: d.position,
        company: d.company,
        domain: d.domain,
        status: "active",
        touchesSent: 0,
        demo: true,
      }));
      ctx.shared.set("rejected", []);
      ctx.logger.info("zero-setup: working the built-in demo contacts", {
        contacts: contacts.length,
      });
      return goto("scrape", { contacts });
    }

    const { contacts, rejected } = normalizeContacts(input.contacts);
    ctx.shared.set("rejected", rejected);
    if (rejected.length > 0) {
      ctx.logger.warn("rejected contacts", { rejected: rejected.length });
    }
    if (contacts.length > 0) {
      ctx.logger.info("accepted opt-in contacts", {
        contacts: contacts.length,
      });
      return goto("scrape", { contacts });
    }
    if (dryRun) {
      return terminate({
        campaign: ctx.shared.get("campaign"),
        dryRun: true,
        reason: "dry-run",
        plan: [],
        rejected,
        note: "A dry run plans new contacts only, and none were supplied or accepted.",
      });
    }
    // No new contacts: a follow-up pass over the stored roster.
    return goto("send", { enrolled: [] });
  },
});

const scrape = defineStep({
  name: "scrape",
  next: ["personalize"],
  async run(input: { contacts: Contact[] }, ctx: Ctx) {
    const contacts = input.contacts ?? [];
    // One scrape per unique domain — several contacts can share a company.
    const domains = [
      ...new Set(contacts.map((c) => c.domain).filter((d): d is string => !!d)),
    ];
    const context = new Map<string, string>();
    if (ctx.shared.get("demoRun")) {
      // `.example` domains don't resolve — this is the canned blurb the page
      // would have returned, standing in for a live fetch that can't succeed.
      for (const d of DEMO_CONTACTS) context.set(d.domain, d.context);
    } else {
      for (const domain of domains) {
        try {
          const page = await ctx.sapiom.search.scrape({
            url: `https://${domain}`,
            formats: ["markdown"],
            onlyMainContent: true,
          });
          const text = (page.markdown ?? "").trim();
          if (text) context.set(domain, text.slice(0, MAX_CONTEXT_CHARS));
        } catch (err) {
          // Paywalls, timeouts, DNS — degrade per-domain; the model still has
          // the contact's name, role, and opt-in source.
          ctx.logger.warn("scrape failed; no context for domain", {
            domain,
            err: String(err),
          });
        }
      }
    }
    ctx.logger.info("scraped company context", {
      domains: domains.length,
      withContext: context.size,
    });
    // Carry the context ONLY to the next step, keyed by domain — the bodies
    // never touch ctx.shared.
    return goto("personalize", {
      contacts,
      context: Object.fromEntries(context),
    });
  },
});

const personalize = defineStep({
  name: "personalize",
  next: ["verify"],
  async run(
    input: { contacts: Contact[]; context: Record<string, string> },
    ctx: Ctx,
  ) {
    const contacts = input.contacts ?? [];
    const context = input.context ?? {};

    if (contacts.length === 0) {
      return goto("verify", { contacts });
    }

    const prospects = contacts
      .map((c, i) => {
        const site = c.domain ? context[c.domain] : "";
        const who = [c.firstName, c.lastName].filter(Boolean).join(" ") || "—";
        return (
          `[${i}] ${who}${c.position ? `, ${c.position}` : ""} at ` +
          `${c.company || c.domain || "unknown"}\n` +
          `ASKED VIA: ${c.optInSource ?? "unknown"}\n` +
          `SITE: ${site ? site.slice(0, 600) : "(no site context)"}`
        );
      })
      .join("\n\n");

    const system =
      "You write the first line of a follow-up email to people who asked to " +
      "hear from us. For each contact you get an index, their name/role/company, " +
      "how they reached out, and a snippet of their company website. Write ONE " +
      "warm, specific first line per contact that acknowledges their request and " +
      "references something concrete about their company — never generic " +
      "flattery, no more than ~25 words, no greeting line and no signature.";
    const prompt = `CONTACTS (${contacts.length}):\n${prospects}`;

    const res = await ctx.sapiom.llm.run({
      request: {
        system,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 8000,
      },
      output: {
        name: OPENERS_TOOL,
        schema: buildOpenersSchema(contacts.length),
      },
    });
    const lines = readOpeners(ctx.sapiom.llm.structuredOf(res, OPENERS_TOOL));

    // A contact the model wrote no opener for is NOT emailed a generic one
    // (SAP-2892): it is marked undeliverable, a channel `verify`, `enroll`, and
    // the run summary already understand.
    const personalized = contacts.map((c, i) => {
      const firstLine = lines[i]?.trim();
      if (firstLine) return { ...c, firstLine };
      return {
        ...c,
        deliverable: false,
        verifyStatus: "no-personalized-opener",
      };
    });
    const withOpener = personalized.filter((c) => c.firstLine).length;
    // Not one contact matched an opener — the model answered about nobody in
    // this batch. Fail the step rather than report every address as
    // undeliverable for what is a model failure.
    if (withOpener === 0) {
      throw new Error(
        "personalize: the model wrote no opener for any contact in this batch — refusing to report it as an undeliverable contact list.",
      );
    }
    if (withOpener < contacts.length) {
      ctx.logger.warn("some contacts got no opener; they will not be emailed", {
        contacts: contacts.length,
        withOpener,
      });
    }
    ctx.logger.info("wrote personalized openers", {
      contacts: personalized.length,
      fromModel: withOpener,
    });
    return goto("verify", { contacts: personalized });
  },
});

const verify = defineStep({
  name: "verify",
  next: ["enroll"],
  async run(input: { contacts: Contact[] }, ctx: Ctx) {
    const contacts = input.contacts ?? [];
    const checked: Contact[] = [];
    for (const c of contacts) {
      // `personalize` already ruled this one out for having no opener. Don't
      // spend a verification on it or flip it back to deliverable below.
      if (c.deliverable === false && c.verifyStatus) {
        checked.push(c);
        continue;
      }
      if (c.demo) {
        // A `.example` address can't be verified. Deterministically
        // deliverable, so the demo reaches a real send to the agent's own inbox.
        checked.push({
          ...c,
          deliverable: true,
          verifyStatus: "demo-stand-in",
        });
        continue;
      }
      try {
        const res = await ctx.sapiom.search.emailSearch.verifyEmail({
          email: c.email,
        });
        const status = (res.status || res.result || "unknown").toLowerCase();
        const badStatus = status === "invalid" || status === "undeliverable";
        const lowScore =
          typeof res.score === "number" && res.score < VERIFY_MIN_SCORE;
        const deliverable = !badStatus && !res.disposable && !lowScore;
        checked.push({ ...c, deliverable, verifyStatus: status });
      } catch (err) {
        // The person gave us this address; a failed check is not a reason to
        // drop them. Send, but flag the address as unverified.
        ctx.logger.warn("verify failed; keeping contact as unverified", {
          email: c.email,
          err: String(err),
        });
        checked.push({ ...c, deliverable: true, verifyStatus: "unverified" });
      }
    }
    ctx.logger.info("verified deliverability", {
      contacts: checked.length,
      deliverable: checked.filter((c) => c.deliverable).length,
    });
    return goto("enroll", { contacts: checked });
  },
});

const enroll = defineStep({
  name: "enroll",
  next: ["send"],
  // Terminal too: a dry run returns the plan and ends here.
  terminal: true,
  async run(input: { contacts: Contact[] }, ctx: Ctx) {
    const contacts = input.contacts ?? [];
    const campaign = ctx.shared.get("campaign") || DEFAULT_CAMPAIGN;
    const demoRun = ctx.shared.get("demoRun") ?? false;
    const deliverable = contacts.filter((c) => c.deliverable);

    ctx.shared.set("contacts", contacts);

    if (ctx.shared.get("dryRun")) {
      ctx.logger.info("dry run: returning plan without sending", {
        contacts: contacts.length,
        deliverable: deliverable.length,
      });
      return terminate({
        campaign,
        dryRun: true,
        reason: "dry-run",
        touches: (ctx.shared.get("sequence") ?? DEFAULT_SEQUENCE).length,
        accepted: contacts.length,
        deliverable: deliverable.length,
        rejected: ctx.shared.get("rejected") ?? [],
        plan: contacts.map((c) => ({
          email: c.email,
          company: c.company,
          optInSource: c.optInSource,
          deliverable: c.deliverable,
          verifyStatus: c.verifyStatus,
          firstLine: c.firstLine,
        })),
      });
    }

    // The roster is what carries a contact from one scheduled pass to the
    // next, so a live run without it cannot keep its promise to follow up.
    const sql = await openSql(
      ctx,
      ctx.shared.get("dbHandle") || DEFAULT_DB_HANDLE,
    );
    if (!sql) {
      throw new Error(
        "enroll: the campaign database is unavailable, so the roster can't be stored and no follow-up could be sent.",
      );
    }
    const enrolled: string[] = [];
    try {
      await initSchema(sql);
      for (const c of deliverable) {
        const values = sql`
          (${campaign}, ${c.email}, ${c.fullName ?? null}, ${c.firstName ?? null},
           ${c.company ?? null}, ${c.position ?? null}, ${c.firstLine ?? null},
           ${c.optInSource ?? null}, ${demoRun ? "demo" : "active"})`;
        // Already enrolled keeps its place in the sequence: a person who signs
        // up twice is not sent touch 1 again. Demo rows are the exception —
        // every zero-setup run starts them over, so each one sends its touch.
        const rows = demoRun
          ? await sql`
              insert into outreach_contacts
                (campaign, email, full_name, first_name, company, position,
                 first_line, opt_in_source, status)
              values ${values}
              on conflict (campaign, email) do update set
                first_line = excluded.first_line, touches_sent = 0,
                last_sent_at = null, thread_id = null, last_message_id = null
              returning email`
          : await sql`
              insert into outreach_contacts
                (campaign, email, full_name, first_name, company, position,
                 first_line, opt_in_source, status)
              values ${values}
              -- An existing opt-in keeps its place in the sequence. A row with
              -- no opt-in source is a cold lead from the old version: this
              -- person has now opted in, so it starts over as theirs.
              on conflict (campaign, email) do update set
                opt_in_source = excluded.opt_in_source,
                first_line = excluded.first_line,
                first_name = excluded.first_name,
                status = 'active', touches_sent = 0, last_sent_at = null,
                thread_id = null, last_message_id = null, inbox_id = null
              where outreach_contacts.opt_in_source is null
              returning email`;
        if (rows.length > 0) enrolled.push(c.email);
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
    ctx.logger.info("enrolled contacts", {
      deliverable: deliverable.length,
      enrolled: enrolled.length,
    });
    return goto("send", { enrolled });
  },
});

/** One roster row as `send` reads it. */
interface RosterRow {
  email: string;
  full_name: string | null;
  first_name: string | null;
  company: string | null;
  position: string | null;
  first_line: string | null;
  opt_in_source: string | null;
  touches_sent: number;
  thread_id: string | null;
  last_message_id: string | null;
  inbox_id: string | null;
  due: boolean;
}

const send = defineStep({
  name: "send",
  next: [],
  terminal: true,
  // Every send in the pass failed: the run ends `failed`, with the failures in
  // its output, rather than `succeeded` having delivered nothing.
  canFail: true,
  async run(input: { enrolled?: string[] }, ctx: Ctx) {
    const campaign = ctx.shared.get("campaign") || DEFAULT_CAMPAIGN;
    const demoRun = ctx.shared.get("demoRun") ?? false;
    const overrides = ctx.shared.get("overrides") ?? {};
    const enrolled = new Set(input?.enrolled ?? []);

    const sql = await openSql(
      ctx,
      ctx.shared.get("dbHandle") || DEFAULT_DB_HANDLE,
    );
    if (!sql) {
      throw new Error(
        "send: the campaign database is unavailable, so the roster can't be read.",
      );
    }

    const failures: SendFailure[] = [];
    const worked: Contact[] = [];
    let sent = 0;
    let replied = 0;
    let finished = 0;
    let waiting = 0;

    try {
      await initSchema(sql);
      // Two overlapping passes (a manual run during a scheduled one) would
      // both find the same touch due. The second one stops here instead.
      const [{ locked }] = await sql<{ locked: boolean }[]>`
        select pg_try_advisory_lock(hashtext(${"outreach:" + campaign})) as locked`;
      if (!locked) {
        return terminate(
          {
            campaign,
            dryRun: false,
            demo: demoRun,
            sent: 0,
            note: `Another run is already working campaign "${campaign}"; this one sent nothing.`,
          },
          { reason: "campaign busy" },
        );
      }

      // Campaign config: this run's explicit fields win, then what an earlier
      // run stored, then the defaults. Stored so a scheduled pass that passes
      // only `campaign` sends the same sequence from the same inbox.
      const [stored] = await sql<
        {
          sequence: Touch[];
          drip_ms: string;
          sender_name: string;
          inbox_id: string | null;
        }[]
      >`select sequence, drip_ms, sender_name, inbox_id
        from outreach_campaigns where campaign = ${campaign}`;
      const sequence =
        overrides.sequence ?? stored?.sequence ?? DEFAULT_SEQUENCE;
      const dripMs =
        overrides.dripMs ??
        (stored ? Number(stored.drip_ms) : DEFAULT_DRIP_DAYS * DAY_MS);
      const senderName =
        overrides.senderName ?? stored?.sender_name ?? "The team";
      ctx.shared.set("sequence", sequence);
      ctx.shared.set("senderName", senderName);
      ctx.shared.set("dripMs", dripMs);

      // `due` is computed by Postgres against its own clock, so a retried
      // pass agrees with the first attempt about who was already sent to.
      const roster = demoRun
        ? await sql<RosterRow[]>`
            select email, full_name, first_name, company, position, first_line,
                   opt_in_source, touches_sent, thread_id, last_message_id, inbox_id, true as due
            from outreach_contacts
            where campaign = ${campaign} and status = 'demo' and touches_sent = 0
            order by created_at`
        : await sql<RosterRow[]>`
            select email, full_name, first_name, company, position, first_line,
                   opt_in_source, touches_sent, thread_id, last_message_id, inbox_id,
                   (last_sent_at is null
                    or last_sent_at + make_interval(secs => ${dripMs / 1000}::float8)
                       <= now()) as due
            from outreach_contacts
            where campaign = ${campaign} and status = 'active'
              -- A row with no opt-in source predates the opt-in rework (a cold
              -- lead from the old enrichment step) and is never emailed.
              and opt_in_source is not null
            order by created_at`;

      if (roster.length === 0 && !stored) {
        return terminate(
          {
            campaign,
            dryRun: false,
            demo: demoRun,
            reason: "no-contacts",
            sent: 0,
            rejected: ctx.shared.get("rejected") ?? [],
            unmet: ["contacts"],
            note: `Campaign "${campaign}" has no contacts. Pass \`contacts\` (each with an \`optInSource\`) to enroll people who asked to hear from you.`,
          },
          { reason: "no contacts" },
        );
      }

      const inboxId =
        overrides.inboxId ??
        stored?.inbox_id ??
        (await resolveSenderInbox(ctx, senderName));
      await sql`
        insert into outreach_campaigns (campaign, sequence, drip_ms, sender_name, inbox_id)
        values (${campaign}, ${sql.json(sequence as unknown as postgres.JSONValue)},
                ${dripMs}, ${senderName}, ${inboxId})
        on conflict (campaign) do update set
          sequence = excluded.sequence, drip_ms = excluded.drip_ms,
          sender_name = excluded.sender_name, inbox_id = excluded.inbox_id,
          updated_at = now()`;

      for (const row of roster) {
        const c: Contact = {
          email: row.email,
          fullName: row.full_name ?? undefined,
          firstName: row.first_name ?? undefined,
          company: row.company ?? undefined,
          position: row.position ?? undefined,
          firstLine: row.first_line ?? undefined,
          optInSource: row.opt_in_source ?? undefined,
          deliverable: true,
          status: demoRun ? "demo" : "active",
          touchesSent: row.touches_sent,
          demo: demoRun,
        };
        const touchIndex = row.touches_sent;

        if (touchIndex >= sequence.length) {
          await sql`update outreach_contacts set status = 'done'
            where campaign = ${campaign} and email = ${c.email}`;
          finished += 1;
          worked.push({ ...c, status: "done" });
          continue;
        }
        if (!row.due) {
          waiting += 1;
          worked.push(c);
          continue;
        }

        // Before any follow-up, read the thread. Anyone other than the sending
        // inbox writing in it is a reply, and a reply ends the sequence.
        const contactInbox = row.inbox_id ?? inboxId;
        if (touchIndex > 0 && row.thread_id) {
          try {
            const thread = await ctx.sapiom.email.threads.get(
              contactInbox,
              row.thread_id,
            );
            const self = addressOf(contactInbox);
            if (thread.messages.some((m) => addressOf(m.from) !== self)) {
              await sql`update outreach_contacts
                set status = 'replied', replied_at = now()
                where campaign = ${campaign} and email = ${c.email}`;
              replied += 1;
              worked.push({ ...c, status: "replied" });
              continue;
            }
          } catch (err) {
            // Without the thread we can't rule out a reply, so this contact is
            // not sent to on this pass. Reported, and retried on the next one.
            failures.push(toFailure(c.email, touchIndex + 1, err));
            worked.push(c);
            continue;
          }
        }

        const touch = sequence[touchIndex];
        const body =
          touchIndex === 0
            ? `${c.firstLine}\n\n${render(touch.body, c, senderName)}`
            : render(touch.body, c, senderName);
        if (touchIndex === 0 && !c.firstLine?.trim()) {
          failures.push({
            email: c.email,
            touch: 1,
            status: null,
            code: "no-personalized-opener",
            error:
              "No opener was written for this contact, so nothing was sent.",
          });
          worked.push(c);
          continue;
        }
        const subject = render(touch.subject, c, senderName);
        let result: { messageId: string; threadId: string };
        try {
          if (demoRun) {
            // The fabricated address is never a real inbox; the demo touch
            // lands in this agent's own inbox instead.
            result = await ctx.sapiom.email.messages.send(inboxId, {
              to: inboxId,
              subject: `[Demo contact] ${subject}`,
              text: `${body}\n\n— Demo contact: ${c.fullName ?? c.firstName} at ${c.company}, who "asked" via ${c.optInSource}. Sent here, to this agent's own inbox, instead of a real person. Pass your own \`contacts\` to reach real people.`,
            });
          } else if (touchIndex === 0 || !row.last_message_id) {
            result = await ctx.sapiom.email.messages.send(contactInbox, {
              to: c.email,
              subject,
              text: body,
            });
          } else {
            // A reply in the first touch's thread: the contact sees one
            // conversation, and their answer lands where the check above reads.
            // `to` is explicit — the default would be the original sender, us.
            result = await ctx.sapiom.email.messages.reply(
              contactInbox,
              row.last_message_id,
              { to: c.email, text: body },
            );
          }
        } catch (err) {
          const failure = toFailure(c.email, touchIndex + 1, err);
          failures.push(failure);
          ctx.logger.warn("send failed", { ...failure });
          worked.push(c);
          continue;
        }

        // The email went out. Count it as sent whatever happens next.
        sent += 1;
        const status = demoRun
          ? "demo"
          : touchIndex + 1 >= sequence.length
            ? "done"
            : "active";
        try {
          await sql`update outreach_contacts set
              touches_sent = touches_sent + 1,
              last_sent_at = now(),
              thread_id = coalesce(thread_id, ${result.threadId ?? null}),
              last_message_id = ${result.messageId ?? null},
              inbox_id = coalesce(inbox_id, ${contactInbox}),
              status = ${status}
            where campaign = ${campaign} and email = ${c.email}`;
          await sql`insert into outreach_touches
              (campaign, email, touch_index, subject, message_id)
            values (${campaign}, ${c.email}, ${touchIndex}, ${subject}, ${result.messageId ?? null})`;
        } catch (err) {
          // Sent but not recorded: the roster still says this touch is due,
          // so the next pass would send it again. Report it as such rather
          // than as a failed send.
          failures.push({
            email: c.email,
            touch: touchIndex + 1,
            status: null,
            code: "sent-not-recorded",
            error: `The email was sent but the roster update failed, so the next run may repeat this touch: ${String(err)}`,
          });
        }
        worked.push({ ...c, touchesSent: touchIndex + 1, status });
      }
    } finally {
      await sql.end({ timeout: 5 });
    }

    // The dashboard reads `contacts` from shared state. On an enrolling run
    // keep what `enroll` stored there (verdicts, contacts that were not
    // deliverable) with each one's new state, then the rest of the roster.
    const byEmail = new Map(worked.map((c) => [c.email, c]));
    const earlier = ctx.shared.get("contacts") ?? [];
    const seen = new Set(earlier.map((c) => c.email));
    const merged = [
      ...earlier.map((c) => ({ ...c, ...(byEmail.get(c.email) ?? {}) })),
      ...worked.filter((c) => !seen.has(c.email)),
    ];
    ctx.shared.set("contacts", merged);

    const blocked = failures.some(
      (f) => f.code === "recipient_not_allowed" || f.status === 403,
    );
    const output = {
      campaign,
      dryRun: false,
      demo: demoRun,
      enrolled: enrolled.size,
      deliverable: merged.filter((c) => c.deliverable).length,
      rejected: ctx.shared.get("rejected") ?? [],
      sent,
      failed: failures.length,
      replied,
      finished,
      waiting,
      sendFailures: failures,
      contacts: merged.map((c) => ({
        email: c.email,
        company: c.company,
        deliverable: c.deliverable,
        verifyStatus: c.verifyStatus,
        status: c.status,
        touchesSent: c.touchesSent ?? 0,
      })),
      ...(demoRun
        ? {
            note: 'This is a zero-setup demo: three built-in sample contacts, an opener from a real model call, and a first touch actually sent to this agent\'s own Sapiom-hosted inbox — open it to read the drafts. Pass your own `contacts` (each with an `optInSource`) to follow up with real people, then attach a schedule with `{ "campaign": "<name>" }` for the follow-ups.',
          }
        : blocked
          ? {
              note: "A free sapiom.email inbox only delivers inside your organization. Pass `inboxId` for an inbox on your own domain to reach these contacts.",
            }
          : {}),
    };
    ctx.logger.info("follow-up pass complete", {
      sent,
      failed: failures.length,
      replied,
      waiting,
      demo: demoRun,
    });

    if (sent === 0 && failures.length > 0) {
      return fail(`every send on this pass failed (${failures.length})`, {
        output,
      });
    }
    return terminate(
      output,
      failures.length > 0
        ? { reason: `${failures.length} send(s) failed` }
        : undefined,
    );
  },
});

// ────────────────────────────────────────────────────── structured output ──
/**
 * The forced tool call `personalize` reads the openers out of. `llm.run`'s
 * `output` appends this tool to the request and pins `tool_choice` to it, so the
 * openers arrive as a typed `tool_use` block — there is no prose to slice and no
 * JSON to hand-parse.
 */
const OPENERS_TOOL = "emit_openers";

/**
 * Built per call so `i` is bounded to THIS batch. An index past the end used to
 * be droppable-but-silent: every contact ended up without an opener. Bounding
 * it at the wire means the model can't produce that shape in the first place.
 */
function buildOpenersSchema(count: number): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      lines: {
        type: "array",
        minItems: 1,
        maxItems: count,
        items: {
          type: "object",
          properties: {
            i: {
              type: "integer",
              minimum: 0,
              maximum: Math.max(0, count - 1),
              description: "The contact's index, as given in the prompt.",
            },
            firstLine: {
              type: "string",
              description:
                "One warm, specific first line that acknowledges their request and references something concrete about their company. Never generic flattery, ~25 words max, no greeting and no signature.",
            },
          },
          required: ["i", "firstLine"],
          additionalProperties: false,
        },
        description: "One entry per contact.",
      },
    },
    required: ["lines"],
    additionalProperties: false,
  };
}

/**
 * Read the forced tool call back into `{ index: opener }`.
 *
 * Throws when the model returned no openers at all. These lines are emailed to
 * real people, so there is nothing safe to substitute — the whole batch quietly
 * falling back to one canned greeting is precisely a run that says `succeeded`
 * while sending nothing anyone wrote.
 */
export function readOpeners(structured: unknown): Record<number, string> {
  if (structured === null || typeof structured !== "object") {
    throw new Error(
      "personalize: the model returned no structured openers — refusing to email a canned greeting.",
    );
  }
  const raw = (structured as { lines?: unknown }).lines;
  if (!Array.isArray(raw)) {
    throw new Error(
      "personalize: the model returned no opener list — refusing to email a canned greeting.",
    );
  }
  const out: Record<number, string> = {};
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    // `typeof`, not `Number(...)`: `Number(null)` is `0`, so coercing would
    // quietly file an entry with no index as contact 0's opener — and contact
    // 0 is a real person who gets emailed it.
    const i = r.i;
    const firstLine = typeof r.firstLine === "string" ? r.firstLine.trim() : "";
    if (typeof i === "number" && Number.isInteger(i) && i >= 0 && firstLine) {
      out[i] = firstLine;
    }
  }
  if (Object.keys(out).length === 0) {
    throw new Error(
      "personalize: the model returned no usable openers — refusing to email a canned greeting.",
    );
  }
  return out;
}

export const agent = defineAgent<EntryInput, Shared>({
  name: "cold-outreach-engine",
  entry: "intake",
  steps: { intake, scrape, personalize, verify, enroll, send },
});
