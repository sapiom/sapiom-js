import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import type { Sapiom } from "@sapiom/tools";

/**
 * Scheduled Research Brief — the scheduled, LLM-curated, delivered sibling of
 * `web-research-digest`.
 *
 * On each tick it searches the web for a `topic`, scrapes the top candidates for
 * full article text, asks an LLM (`ctx.sapiom.models.run` — the live x402-served
 * model, NOT a hardcoded formatter) to rank + curate the findings into a short
 * sourced brief, then delivers that brief by email. It ships with a `schedule`
 * input so it reads as a standing "morning brief" agent rather than a manual
 * one-shot.
 *
 * Composition, in one legible graph:
 *   search (web.search) → scrape (web.scrape) → curate (models.run) → deliver (email)
 *
 * vs. `web-research-digest`: fork THAT for a one-shot digest that formats
 * in-process (no LLM, no delivery); fork THIS for a standing, LLM-curated brief
 * that lands in an inbox on a cron cadence.
 *
 * Side-effect discipline (copied from `mushroom-cloud` / `backlog-nudge`):
 *   - `dryRun` gates the real send: it computes the brief and returns it as a
 *     preview without emailing anyone. `run_local` uses this to trace the whole
 *     graph offline (capabilities stubbed) for free before a billed, delivering
 *     deploy + run.
 *   - The recipient is resolved from the Sapiom vault at runtime and never
 *     persisted in execution state — the same seam you'd read a delivery secret
 *     from if you swapped in a bring-your-own channel (see `AGENTS.md`).
 *   - Each edge carries a slim payload; the large scraped bodies stay bounded and
 *     die at the `curate` boundary — they never enter `ctx.shared` (big shared
 *     state stalls transitions, per the `backlog-nudge` boundary lesson).
 */

// ─────────────────────────────────────────────────────────────── config ──
/** Default cadence when the caller doesn't pass one: 08:00 every day. */
const DEFAULT_SCHEDULE = "0 8 * * *";
/** How many search hits to consider as scrape candidates. */
const MAX_CANDIDATES = 5;
/** How many candidates to actually scrape (keeps latency + cost bounded). */
const MAX_SCRAPES = 4;
/** Truncate each scraped body — the ONLY large data on the search→curate path. */
const MAX_BODY_CHARS = 1200;
/** Vault ref holding delivery config (e.g. a default RECIPIENT). Read at runtime. */
const DELIVERY_VAULT_REF = "scheduled-research-brief";
/** Username for the inbox we send from (created once, then reused). */
const SENDER_USERNAME = "research-brief";

// ─────────────────────────────────────────────────────────────── shapes ──
interface EntryInput {
  /** What to research on each tick. */
  topic: string;
  /** Cron cadence this brief is meant to run on (e.g. "0 8 * * *"). */
  schedule?: string;
  /** Recipient email; falls back to the vault-configured default when omitted. */
  deliverTo?: string;
  /** Compute the brief but skip the real send. `run_local` passes this. */
  dryRun?: boolean;
}

/** Slim search hit carried across the search → scrape boundary. */
interface Candidate {
  title: string;
  url: string;
  snippet: string;
}

/** A candidate plus its (bounded) scraped body — the scrape → curate payload. */
interface ScrapedSource extends Candidate {
  /** Extracted article text (markdown, truncated); absent when scraping failed. */
  content?: string;
}

/** The slim source reference that crosses curate → deliver and lands in output. */
interface Source {
  title: string;
  url: string;
}

interface Shared extends Record<string, unknown> {
  topic: string;
  schedule: string;
  deliverTo: string | null;
  dryRun: boolean;
  brief: string;
  sources: Source[];
}

type Ctx = AgentExecutionContext<Shared>;

// ─────────────────────────────────────────────────────────────── helpers ──
/**
 * Resolve the recipient from the vault at runtime. A missing ref/key is an
 * expected outcome (`vault.get` returns null), not an error — the caller then
 * falls back to a dry-run preview. This is also the seam where a bring-your-own
 * delivery secret would be read; it is never persisted in execution state.
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
    displayName: "Research Brief",
  });
  return inbox.inboxId;
}

// ─────────────────────────────────────────────────────────────── steps ──
const search = defineStep({
  name: "search",
  next: ["scrape"],
  async run(input: EntryInput, ctx: Ctx) {
    const topic = input.topic?.trim() ?? "";
    ctx.shared.set("topic", topic);
    ctx.shared.set("schedule", input.schedule?.trim() || DEFAULT_SCHEDULE);
    ctx.shared.set("deliverTo", input.deliverTo?.trim() || null);
    ctx.shared.set("dryRun", input.dryRun === true);

    if (!topic) {
      // Nothing to research — hand an empty candidate list to the next step so
      // the graph still traces end to end.
      return goto("scrape", { candidates: [] as Candidate[] });
    }

    ctx.logger.info("searching the web", { topic });
    const hits = await ctx.sapiom.search.webSearch({
      query: topic,
      intent: "links",
    });
    const candidates: Candidate[] = hits.results
      .slice(0, MAX_CANDIDATES)
      .map((r) => ({ title: r.title, url: r.url, snippet: r.snippet }));
    ctx.logger.info("search returned candidates", { count: candidates.length });
    return goto("scrape", { candidates });
  },
});

const scrape = defineStep({
  name: "scrape",
  next: ["curate"],
  async run(input: { candidates: Candidate[] }, ctx: Ctx) {
    const candidates = input.candidates ?? [];
    const sources: ScrapedSource[] = [];
    let scraped = 0;
    for (const c of candidates) {
      // Beyond the scrape budget we still forward the candidate — the snippet
      // alone is useful curation context.
      if (scraped >= MAX_SCRAPES) {
        sources.push(c);
        continue;
      }
      try {
        const page = await ctx.sapiom.search.scrape({
          url: c.url,
          formats: ["markdown"],
          onlyMainContent: true,
        });
        scraped += 1;
        sources.push({
          title: page.metadata?.title || c.title,
          url: c.url,
          snippet: c.snippet,
          content: (page.markdown ?? "").slice(0, MAX_BODY_CHARS),
        });
      } catch (err) {
        // Scrapes fail routinely (paywalls, timeouts); degrade per-item, never
        // throw — a curated brief from the survivors beats an aborted run.
        ctx.logger.warn("scrape failed; keeping snippet only", {
          url: c.url,
          err: String(err),
        });
        sources.push(c);
      }
    }
    ctx.logger.info("scraped candidates", { scraped, total: sources.length });
    return goto("curate", { sources });
  },
});

const curate = defineStep({
  name: "curate",
  next: ["deliver"],
  async run(input: { sources: ScrapedSource[] }, ctx: Ctx) {
    const topic = ctx.shared.get("topic") || "your topic";
    const sources = input.sources ?? [];
    // Slim references only — the scraped bodies stop here and never reach shared
    // state or the deliver boundary.
    const slimSources: Source[] = sources.map((s) => ({
      title: s.title,
      url: s.url,
    }));

    let brief: string;
    if (sources.length === 0) {
      brief = `# Research brief: ${topic}\n\n_No sources were found for this topic._`;
    } else {
      const research = sources
        .map(
          (s, i) =>
            `[${i + 1}] ${s.title} (${s.url})\n${(s.content || s.snippet).slice(0, MAX_BODY_CHARS)}`,
        )
        .join("\n\n");
      // The live, x402-served model does the ranking + synthesis — this is the
      // capability web-research-digest deliberately avoids (it formats in-process).
      const curation = await ctx.sapiom.models.run({
        system:
          "You are a research analyst writing a short morning brief. Given a " +
          "TOPIC and a set of web SOURCES (each: [n] title, url, extracted text), " +
          "rank them by relevance and credibility, drop thin or duplicate items, " +
          "and write markdown with: a 2-3 sentence summary, then 3-5 bullet " +
          "takeaways that each cite their source as a [n] reference, then a " +
          "'## Sources' list mapping each [n] to its title and url. Output ONLY " +
          "the markdown brief — no preamble, no code fences.",
        prompt: `TOPIC: ${topic}\n\nSOURCES:\n${research}`,
        maxTokens: 800,
      });
      brief =
        (curation.output ?? "").trim() ||
        `# Research brief: ${topic}\n\n_The model returned no content._`;
    }

    ctx.shared.set("brief", brief);
    ctx.shared.set("sources", slimSources);
    ctx.logger.info("curated brief", {
      topic,
      chars: brief.length,
      sources: slimSources.length,
    });
    return goto("deliver", { brief, sources: slimSources });
  },
});

const deliver = defineStep({
  name: "deliver",
  next: [],
  terminal: true,
  async run(input: { brief: string; sources: Source[] }, ctx: Ctx) {
    const topic = ctx.shared.get("topic") || "your topic";
    const schedule = ctx.shared.get("schedule") || DEFAULT_SCHEDULE;
    const dryRun = ctx.shared.get("dryRun") ?? true;
    const brief = input.brief ?? "";
    const sources = input.sources ?? [];
    const subject = `Research brief: ${topic}`;

    // Explicit input wins; otherwise resolve the default from the vault at
    // runtime (never carried through state).
    const deliverTo =
      ctx.shared.get("deliverTo") || (await recipientFromVault(ctx));

    // The safe path: a dry run — or a live run with no recipient configured yet —
    // returns the computed brief without sending anything.
    if (dryRun || !deliverTo) {
      ctx.logger.info("skipping delivery", {
        dryRun,
        hasRecipient: Boolean(deliverTo),
      });
      return terminate({
        topic,
        schedule,
        delivered: false,
        dryRun,
        reason: dryRun ? "dry-run" : "no-recipient",
        to: deliverTo ?? null,
        subject,
        brief,
        sources,
      });
    }

    const inboxId = await resolveSenderInbox(ctx);
    const sent = await ctx.sapiom.email.messages.send(inboxId, {
      to: deliverTo,
      subject,
      text: brief,
    });
    ctx.logger.info("brief delivered", {
      to: deliverTo,
      messageId: sent.messageId,
    });
    return terminate({
      topic,
      schedule,
      delivered: true,
      dryRun: false,
      to: deliverTo,
      subject,
      messageId: sent.messageId,
      sources,
    });
  },
});

export const agent = defineAgent<EntryInput, Shared>({
  name: "scheduled-research-brief",
  entry: "search",
  steps: { search, scrape, curate, deliver },
});
