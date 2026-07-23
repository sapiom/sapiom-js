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
 * Cold Outreach Personalization Engine — turn a raw lead list into a
 * personalized, deliverability-checked drip sequence that runs itself.
 *
 * On each run it enriches your leads, researches each company, writes a
 * specific opener for every prospect, drops the addresses that would bounce,
 * and then sends the sequence one touch at a time — pausing at $0 between
 * touches and stopping the moment someone replies.
 *
 *   enrich (Hunter) ─▶ scrape (web) ─▶ personalize (models.run) ─▶ verify (Hunter)
 *      └─▶ launch (database) ─▶ send (email) ⇄ advance ─▶ done
 *
 *   - **enrich** takes a lead list — a company domain, optionally a person —
 *     and resolves a real contact with Hunter: `findEmail` when you name the
 *     person, `domainSearch` to surface a decision-maker when you only have the
 *     company. Per-lead failures are skipped, never fatal.
 *   - **scrape** reads each company's site (`web.scrape`) for a few lines of
 *     context. The bodies are bounded and die here — they never enter shared
 *     state or cross the drip edges.
 *   - **personalize** hands those snippets to the live model (`models.run`) and
 *     gets back one concrete first line per prospect, falling back to a safe
 *     generic opener when the model returns nothing usable.
 *   - **verify** checks each address for deliverability (Hunter `verifyEmail`)
 *     and drops the ones that would bounce before a single email goes out.
 *   - **launch** persists the campaign and its contacts to a Postgres store the
 *     engine owns, then hands off to the drip. A `dryRun` stops here and returns
 *     the full plan — openers and all — without sending or persisting anything.
 *   - **send** delivers the current touch to everyone still active and logs it,
 *     then pauses until either the drip interval elapses or a prospect replies.
 *   - **advance** wakes on that reply-or-timeout, marks anyone who replied as
 *     done, and either loops back for the next touch or ends the run.
 *
 * Durability: the wait between touches is a `pauseUntilSignal` with a timeout —
 * it costs nothing while idle, resumes on its own when the interval passes, and
 * short-circuits the instant a `reply.received` signal arrives. Determinism:
 * each step body runs once on the happy path (again only on retry), and every
 * timestamp is captured server-side via Postgres `now()`.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** Postgres handle the engine owns — created on first run, reused after. */
const DEFAULT_DB_HANDLE = "cold-outreach-engine";
/** Username for the inbox we send from (created once, then reused). */
const SENDER_USERNAME = "cold-outreach";
/** The named signal a reply-webhook fires to end the drip early. */
const REPLY_SIGNAL = "reply.received";
/** Cap the lead list so cost + latency stay bounded. */
const MAX_LEADS = 25;
/** Truncate each scraped body — the ONLY large data on the scrape→personalize path. */
const MAX_CONTEXT_CHARS = 1500;
/** Days between drip touches when the caller doesn't pass one. */
const DEFAULT_DRIP_DAYS = 3;
/** Below this Hunter confidence score, treat an address as undeliverable. */
const VERIFY_MIN_SCORE = 50;
/** Default cadence documented for the cron trigger: 09:00 on weekdays. */
const DEFAULT_SCHEDULE = "0 9 * * 1-5";
/** Milliseconds in a day — drip interval math. */
const DAY_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────── shapes ──
/** One row of the lead list. A domain is enough; a name sharpens the match. */
interface Lead {
  /** Company domain, e.g. `"example.com"`. Provide this or `company`. */
  domain?: string;
  /** Company name, as an alternative to `domain`. */
  company?: string;
  /** Prospect's full name — when set, we look up their exact address. */
  fullName?: string;
  /** Prospect's first name (pair with `lastName`, or use `fullName`). */
  firstName?: string;
  /** Prospect's last name (pair with `firstName`, or use `fullName`). */
  lastName?: string;
}

/** One touch in the drip sequence. Tokens: {firstName} {company} {sender}. */
interface Touch {
  subject: string;
  body: string;
}

interface EntryInput {
  /** The leads to work through on this run. */
  leads?: Lead[];
  /** Campaign name — also the key for the dedup/log store. */
  campaign?: string;
  /** The drip sequence; defaults to a three-touch sequence. */
  sequence?: Touch[];
  /** Days to wait between touches (default 3). */
  dripIntervalDays?: number;
  /** Display name signed on the outgoing mail. */
  senderName?: string;
  /** Cron cadence this engine is meant to run on (documentation only). */
  schedule?: string;
  /** Postgres handle for the campaign store; defaults to the template handle. */
  dbHandle?: string;
  /** Compute the plan and openers but skip the send, the DB, and the drip. */
  dryRun?: boolean;
}

/** A resolved, workable contact — grows a first line and a verdict downstream. */
interface Contact {
  email: string;
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
  /** Hunter's verification verdict, for the summary (added by `verify`). */
  verifyStatus?: string;
  /** Drip state: "active" until it replies or the sequence ends. */
  status?: "active" | "replied" | "done";
}

interface Shared extends Record<string, unknown> {
  campaign: string;
  dbHandle: string;
  dryRun: boolean;
  schedule: string;
  senderName: string;
  dripMs: number;
  sequence: Touch[];
  contacts: Contact[];
  touchIndex: number;
  sent: number;
  replied: number;
}

type Ctx = AgentExecutionContext<Shared>;
type Sql = ReturnType<typeof postgres>;

/** The three-touch default drip — a personalized open, a bump, and a breakup. */
const DEFAULT_SEQUENCE: Touch[] = [
  {
    subject: "Quick idea for {company}",
    body: "Worth a short call to dig in? Either way, happy to share a couple of thoughts.\n\nBest,\n{sender}",
  },
  {
    subject: "Re: Quick idea for {company}",
    body: "Bumping this in case it slipped — inboxes get busy. Still glad to send over a couple of ideas for {company} whenever the timing's right.\n\nBest,\n{sender}",
  },
  {
    subject: "Closing the loop, {firstName}",
    body: "I'll stop here so I'm not a bother. If growing {company} is on your list this quarter, just reply and I'll pick it back up.\n\nAll the best,\n{sender}",
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

/** A benign opener used when the model gives us nothing we can use. */
function fallbackFirstLine(c: Contact): string {
  const who = c.firstName?.trim() || "there";
  const org = c.company?.trim() || "your team";
  return `Hi ${who} — I've been following what ${org} is building and wanted to reach out.`;
}

/** Normalize + bound the lead list so downstream cost stays predictable. */
function normalizeLeads(raw: unknown): Lead[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l): l is Lead => Boolean(l) && typeof l === "object")
    .map((l) => ({
      domain: l.domain?.trim() || undefined,
      company: l.company?.trim() || undefined,
      fullName: l.fullName?.trim() || undefined,
      firstName: l.firstName?.trim() || undefined,
      lastName: l.lastName?.trim() || undefined,
    }))
    .filter((l) => Boolean(l.domain || l.company))
    .slice(0, MAX_LEADS);
}

/** True when a lead names a specific person we can look up directly. */
function hasPerson(l: Lead): boolean {
  return Boolean(l.fullName || (l.firstName && l.lastName));
}

/** Open a Postgres client for a live run, or null when unavailable. */
async function openSql(ctx: Ctx, handle: string): Promise<Sql | null> {
  try {
    let db;
    try {
      db = await ctx.sapiom.database.get(handle);
    } catch {
      db = await ctx.sapiom.database.create({
        handle,
        duration: "7d",
        name: "Cold Outreach Engine",
        description: "Campaign contacts, drip touches, and reply state",
      });
    }
    const conn = db.connection?.connectionString ?? null;
    if (!conn) {
      ctx.logger.warn("database: no connection string", { handle });
      return null;
    }
    return postgres(conn, { ssl: "require", connect_timeout: 10 });
  } catch (err) {
    // A stubbed / unreachable DB degrades to "no persistence" rather than
    // aborting the drip — the working set lives in ctx.shared regardless.
    ctx.logger.warn("database: unavailable, continuing without persistence", {
      err: String(err),
    });
    return null;
  }
}

async function initSchema(sql: Sql): Promise<void> {
  await sql`
    create table if not exists outreach_contacts (
      campaign    text not null,
      email       text not null,
      full_name   text,
      company     text,
      position    text,
      first_line  text,
      status      text not null default 'active',
      replied_at  timestamptz,
      created_at  timestamptz not null default now(),
      primary key (campaign, email)
    )`;
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

/** Reuse an existing inbox to send from, else provision one. */
async function resolveSenderInbox(
  ctx: Ctx,
  displayName: string,
): Promise<string> {
  const existing = await ctx.sapiom.email.inboxes.list({ limit: 1 });
  if (existing.inboxes.length > 0) return existing.inboxes[0].inboxId;
  const inbox = await ctx.sapiom.email.inboxes.create({
    username: SENDER_USERNAME,
    displayName,
  });
  return inbox.inboxId;
}

// ─────────────────────────────────────────────────────────────── steps ──
const enrich = defineStep({
  name: "enrich",
  next: ["scrape"],
  async run(input: EntryInput, ctx: Ctx) {
    const leads = normalizeLeads(input.leads);
    const sequence =
      Array.isArray(input.sequence) && input.sequence.length > 0
        ? input.sequence
        : DEFAULT_SEQUENCE;
    const dripDays =
      Number(input.dripIntervalDays) > 0
        ? Number(input.dripIntervalDays)
        : DEFAULT_DRIP_DAYS;

    ctx.shared.set("campaign", input.campaign?.trim() || "cold-outreach");
    ctx.shared.set("dbHandle", input.dbHandle?.trim() || DEFAULT_DB_HANDLE);
    ctx.shared.set("dryRun", truthy(input.dryRun));
    ctx.shared.set("schedule", input.schedule?.trim() || DEFAULT_SCHEDULE);
    ctx.shared.set("senderName", input.senderName?.trim() || "The team");
    ctx.shared.set("dripMs", dripDays * DAY_MS);
    ctx.shared.set("sequence", sequence);
    ctx.shared.set("touchIndex", 0);
    ctx.shared.set("sent", 0);
    ctx.shared.set("replied", 0);

    const byEmail = new Map<string, Contact>();
    for (const lead of leads) {
      try {
        if (hasPerson(lead)) {
          // We know who — look up their exact address.
          const found = await ctx.sapiom.search.emailSearch.findEmail({
            domain: lead.domain,
            company: lead.company,
            fullName: lead.fullName,
            firstName: lead.firstName,
            lastName: lead.lastName,
          });
          if (found.email) {
            byEmail.set(found.email.toLowerCase(), {
              email: found.email,
              firstName: found.firstName ?? lead.firstName,
              lastName: found.lastName ?? lead.lastName,
              fullName: lead.fullName,
              position: found.position,
              company: found.company ?? lead.company,
              domain: lead.domain,
              status: "active",
            });
          }
        } else if (lead.domain) {
          // We only have the company — surface a decision-maker.
          const res = await ctx.sapiom.search.emailSearch.domainSearch({
            domain: lead.domain,
            limit: 3,
            type: "personal",
            seniority: ["senior", "executive"],
          });
          const best = res.emails.find((e) => e.email) ?? res.emails[0];
          if (best?.email) {
            byEmail.set(best.email.toLowerCase(), {
              email: best.email,
              firstName: best.firstName,
              lastName: best.lastName,
              position: best.position,
              company: res.organization ?? lead.company,
              domain: lead.domain,
              status: "active",
            });
          }
        }
      } catch (err) {
        // Enrichment fails routinely (no match, rate limit); skip the lead,
        // never abort the batch.
        ctx.logger.warn("enrich failed for lead; skipping", {
          domain: lead.domain,
          err: String(err),
        });
      }
    }

    const contacts = [...byEmail.values()];
    ctx.logger.info("enriched leads into contacts", {
      leads: leads.length,
      contacts: contacts.length,
    });
    return goto("scrape", { contacts });
  },
});

const scrape = defineStep({
  name: "scrape",
  next: ["personalize"],
  async run(input: { contacts: Contact[] }, ctx: Ctx) {
    const contacts = input.contacts ?? [];
    // One scrape per unique domain — many contacts can share a company.
    const domains = [
      ...new Set(contacts.map((c) => c.domain).filter((d): d is string => !!d)),
    ];
    const context = new Map<string, string>();
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
        // Paywalls, timeouts, DNS — degrade per-domain; the opener falls back.
        ctx.logger.warn("scrape failed; no context for domain", {
          domain,
          err: String(err),
        });
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
          `SITE: ${site ? site.slice(0, 600) : "(no site context)"}`
        );
      })
      .join("\n\n");

    const system =
      "You write cold-email openers. For each prospect you get an index, their " +
      "name/role/company, and a snippet of their company website. Write ONE " +
      "warm, specific first line per prospect that references something concrete " +
      "about their company — never generic flattery, no more than ~25 words, no " +
      "greeting line and no signature. Reply with ONLY minified JSON: " +
      '{"lines":[{"i":number,"firstLine":string}]}.';
    const prompt = `PROSPECTS (${contacts.length}):\n${prospects}`;

    let lines: Record<number, string> = {};
    try {
      const res = await ctx.sapiom.models.run({
        system,
        prompt,
        maxTokens: 700,
      });
      lines = parseLines(res.output);
    } catch (err) {
      // A model error is not fatal — every contact falls back to a safe opener.
      ctx.logger.warn("personalize model call failed; using fallbacks", {
        err: String(err),
      });
    }

    const personalized = contacts.map((c, i) => ({
      ...c,
      firstLine: lines[i]?.trim() || fallbackFirstLine(c),
    }));
    ctx.logger.info("wrote personalized openers", {
      contacts: personalized.length,
      fromModel: Object.keys(lines).length,
    });
    return goto("verify", { contacts: personalized });
  },
});

const verify = defineStep({
  name: "verify",
  next: ["launch"],
  async run(input: { contacts: Contact[] }, ctx: Ctx) {
    const contacts = input.contacts ?? [];
    const checked: Contact[] = [];
    for (const c of contacts) {
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
        // If verification itself errors, don't silently drop the lead — send
        // to it but flag the address as unverified.
        ctx.logger.warn("verify failed; keeping contact as unverified", {
          email: c.email,
          err: String(err),
        });
        checked.push({ ...c, deliverable: true, verifyStatus: "unverified" });
      }
    }
    const deliverable = checked.filter((c) => c.deliverable).length;
    ctx.logger.info("verified deliverability", {
      contacts: checked.length,
      deliverable,
    });
    return goto("launch", { contacts: checked });
  },
});

const launch = defineStep({
  name: "launch",
  next: ["send"],
  // Terminal too: a dry run returns the plan and ends here instead of dripping.
  terminal: true,
  async run(input: { contacts: Contact[] }, ctx: Ctx) {
    const contacts = input.contacts ?? [];
    const dryRun = ctx.shared.get("dryRun") ?? true;
    const campaign = ctx.shared.get("campaign") || "cold-outreach";
    const sequence = ctx.shared.get("sequence") ?? DEFAULT_SEQUENCE;
    const deliverable = contacts.filter((c) => c.deliverable);

    ctx.shared.set("contacts", contacts);

    // Safe path: a dry run returns the full plan — every opener — without
    // sending, persisting, or entering the drip.
    if (dryRun) {
      ctx.logger.info("dry run: returning plan without sending", {
        contacts: contacts.length,
        deliverable: deliverable.length,
      });
      return terminate({
        campaign,
        dryRun: true,
        reason: "dry-run",
        touches: sequence.length,
        enriched: contacts.length,
        deliverable: deliverable.length,
        plan: contacts.map((c) => ({
          email: c.email,
          company: c.company,
          deliverable: c.deliverable,
          verifyStatus: c.verifyStatus,
          firstLine: c.firstLine,
        })),
      });
    }

    // Live path: persist the campaign roster (best-effort), then start the drip.
    const handle = ctx.shared.get("dbHandle") || DEFAULT_DB_HANDLE;
    const sql = await openSql(ctx, handle);
    if (sql) {
      try {
        await initSchema(sql);
        for (const c of deliverable) {
          await sql`
            insert into outreach_contacts
              (campaign, email, full_name, company, position, first_line, status)
            values
              (${campaign}, ${c.email}, ${c.fullName ?? null}, ${c.company ?? null},
               ${c.position ?? null}, ${c.firstLine ?? null}, 'active')
            on conflict (campaign, email) do update set
              full_name  = excluded.full_name,
              company    = excluded.company,
              position   = excluded.position,
              first_line = excluded.first_line`;
        }
      } catch (err) {
        ctx.logger.warn("launch: persistence failed, continuing", {
          err: String(err),
        });
      } finally {
        await sql.end({ timeout: 5 });
      }
    }

    ctx.shared.set("touchIndex", 0);
    return goto("send", {});
  },
});

const send = defineStep({
  name: "send",
  next: ["advance", "done"],
  // Static graph edge: on REPLY_SIGNAL, resume at `advance`. Matches the directive.
  pause: { signal: REPLY_SIGNAL, resumeStep: "advance" },
  async run(_input: unknown, ctx: Ctx) {
    const campaign = ctx.shared.get("campaign") || "cold-outreach";
    const sequence = ctx.shared.get("sequence") ?? DEFAULT_SEQUENCE;
    const senderName = ctx.shared.get("senderName") || "The team";
    const dbHandle = ctx.shared.get("dbHandle") || DEFAULT_DB_HANDLE;
    const touchIndex = ctx.shared.get("touchIndex") ?? 0;
    const contacts = ctx.shared.get("contacts") ?? [];
    const active = contacts.filter(
      (c) => c.deliverable && c.status === "active",
    );
    const touch = sequence[touchIndex];

    if (active.length === 0 || !touch) {
      ctx.logger.info("nothing to send", {
        touchIndex,
        active: active.length,
      });
      return goto("done", {});
    }

    const inboxId = await resolveSenderInbox(ctx, senderName);
    const sql = await openSql(ctx, dbHandle);
    let sentThisTouch = 0;
    try {
      for (const c of active) {
        const subject = render(touch.subject, c, senderName);
        // The first touch leads with the personalized opener; later touches
        // reference the thread and skip it.
        const body =
          touchIndex === 0
            ? `${c.firstLine ?? fallbackFirstLine(c)}\n\n${render(touch.body, c, senderName)}`
            : render(touch.body, c, senderName);
        try {
          const sent = await ctx.sapiom.email.messages.send(inboxId, {
            to: c.email,
            subject,
            text: body,
          });
          sentThisTouch += 1;
          if (sql) {
            await sql`
              insert into outreach_touches
                (campaign, email, touch_index, subject, message_id)
              values
                (${campaign}, ${c.email}, ${touchIndex}, ${subject}, ${sent.messageId ?? null})`;
          }
        } catch (err) {
          ctx.logger.warn("send failed for contact", {
            email: c.email,
            err: String(err),
          });
        }
      }
    } finally {
      if (sql) await sql.end({ timeout: 5 });
    }

    ctx.shared.set("sent", (ctx.shared.get("sent") ?? 0) + sentThisTouch);
    ctx.logger.info("sent drip touch", {
      touchIndex,
      recipients: active.length,
      sent: sentThisTouch,
    });

    // Last touch: nothing left to wait for.
    if (touchIndex >= sequence.length - 1) {
      return goto("done", {});
    }

    // Durable wait: idle at $0 until the interval elapses OR a reply lands.
    const dripMs = ctx.shared.get("dripMs") ?? DEFAULT_DRIP_DAYS * DAY_MS;
    ctx.logger.info("pausing between touches", {
      nextTouch: touchIndex + 1,
      dripMs,
    });
    return pauseUntilSignal({
      signal: REPLY_SIGNAL,
      resumeStep: "advance",
      correlationId: ctx.executionId,
      timeoutMs: dripMs,
    });
  },
});

const advance = defineStep({
  name: "advance",
  next: ["send", "done"],
  // Input is the reply-signal payload (`{ email }`) or empty on timeout.
  async run(input: { email?: string } | undefined, ctx: Ctx) {
    const campaign = ctx.shared.get("campaign") || "cold-outreach";
    const dbHandle = ctx.shared.get("dbHandle") || DEFAULT_DB_HANDLE;
    const sequence = ctx.shared.get("sequence") ?? DEFAULT_SEQUENCE;
    const contacts = ctx.shared.get("contacts") ?? [];
    const replyEmail = input?.email?.trim().toLowerCase();

    // A reply short-circuits the drip for that prospect.
    if (replyEmail) {
      let replied = false;
      const updated = contacts.map((c) => {
        if (c.email.toLowerCase() === replyEmail && c.status === "active") {
          replied = true;
          return { ...c, status: "replied" as const };
        }
        return c;
      });
      ctx.shared.set("contacts", updated);
      if (replied) {
        ctx.shared.set("replied", (ctx.shared.get("replied") ?? 0) + 1);
        const sql = await openSql(ctx, dbHandle);
        if (sql) {
          try {
            await sql`
              update outreach_contacts set status = 'replied', replied_at = now()
              where campaign = ${campaign} and email = ${replyEmail}`;
          } catch (err) {
            ctx.logger.warn("advance: reply persist failed", {
              err: String(err),
            });
          } finally {
            await sql.end({ timeout: 5 });
          }
        }
        ctx.logger.info("prospect replied; removed from drip", {
          email: replyEmail,
        });
      }
    }

    const touchIndex = (ctx.shared.get("touchIndex") ?? 0) + 1;
    ctx.shared.set("touchIndex", touchIndex);
    const stillActive = (ctx.shared.get("contacts") ?? []).filter(
      (c) => c.deliverable && c.status === "active",
    );

    if (stillActive.length > 0 && touchIndex < sequence.length) {
      return goto("send", {});
    }
    return goto("done", {});
  },
});

const done = defineStep({
  name: "done",
  next: [],
  terminal: true,
  async run(_input: unknown, ctx: Ctx) {
    const contacts = ctx.shared.get("contacts") ?? [];
    const campaign = ctx.shared.get("campaign") || "cold-outreach";
    const summary = {
      campaign,
      dryRun: false,
      touchesSent: ctx.shared.get("touchIndex") ?? 0,
      enriched: contacts.length,
      deliverable: contacts.filter((c) => c.deliverable).length,
      sent: ctx.shared.get("sent") ?? 0,
      replied: ctx.shared.get("replied") ?? 0,
      contacts: contacts.map((c) => ({
        email: c.email,
        company: c.company,
        deliverable: c.deliverable,
        status: c.status,
      })),
    };
    ctx.logger.info("outreach run complete", {
      sent: summary.sent,
      replied: summary.replied,
    });
    return terminate(summary);
  },
});

// ─────────────────────────────────────────────────────────────── parsing ──
/** Extract `{ i, firstLine }` pairs from the model output; empty on failure. */
function parseLines(output: string | null): Record<number, string> {
  const out: Record<number, string> = {};
  if (!output) return out;
  try {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start < 0 || end < 0) return out;
    const parsed = JSON.parse(output.slice(start, end + 1)) as {
      lines?: unknown;
    };
    if (!Array.isArray(parsed.lines)) return out;
    for (const raw of parsed.lines) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const i = Number(r.i);
      const firstLine = String(r.firstLine ?? "").trim();
      if (Number.isInteger(i) && i >= 0 && firstLine) out[i] = firstLine;
    }
  } catch {
    // Non-JSON (e.g. the run_local stub placeholder) → every contact falls back.
  }
  return out;
}

export const agent = defineAgent<EntryInput, Shared>({
  name: "cold-outreach-engine",
  entry: "enrich",
  steps: { enrich, scrape, personalize, verify, launch, send, advance, done },
});
