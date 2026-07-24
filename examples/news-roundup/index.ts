import {
  defineAgent,
  defineStep,
  fail,
  goto,
  retry,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { z } from "zod/v4";
import {
  buildIndexPage,
  buildRoundupPage,
  imageStorageName,
  pageStorageName,
  roundupDatesFromFileNames,
  SERVER_JS,
} from "./lib/html.js";
import { buildSelectionPrompt, parseSelection } from "./lib/select.js";
import { downloadFileBytes, listFilesByPrefix, uploadPublicFile } from "./lib/storage.js";
import type {
  IllustratedArticle,
  RawArticle,
  RoundupShared,
  SelectedArticle,
} from "./lib/types.js";
import { slugify, todayIso } from "./lib/util.js";

const entryInput = z.object({ companyName: z.string().min(1) });
const SITE_PORT = 3000;

const search = defineStep({
  name: "search",
  next: ["select"],
  terminal: true,
  canFail: true,
  inputSchema: entryInput,
  async run(input: { companyName: string }, ctx: AgentExecutionContext<RoundupShared>) {
    const companyName = input.companyName.trim();
    const companySlug = slugify(companyName);
    ctx.shared.set("companyName", companyName);
    ctx.shared.set("companySlug", companySlug);
    ctx.shared.set("runDate", todayIso());
    ctx.shared.set("storagePrefix", `news-roundup/${companySlug}/`);
    try {
      const res = await ctx.sapiom.search.webSearch({
        query: `"${companyName}" company news from the last 7 days`,
        intent: "links",
      });
      const articles: RawArticle[] = res.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
      }));
      if (articles.length === 0) {
        ctx.logger.info("no news found", { companyName });
        return terminate({ status: "no-news", companyName });
      }
      ctx.logger.info("search done", { count: articles.length });
      return goto("select", { articles });
    } catch (err) {
      if (ctx.attempts + 1 < 3) return retry({ delayMs: 1000 });
      return fail(`search failed: ${String(err)}`);
    }
  },
});

const select = defineStep({
  name: "select",
  next: ["illustrate"],
  canFail: true,
  async run(input: { articles: RawArticle[] }, ctx: AgentExecutionContext<RoundupShared>) {
    const companyName = ctx.shared.get("companyName") ?? "";
    const runDate = ctx.shared.get("runDate") ?? "";
    try {
      const res = await ctx.sapiom.models.run({
        prompt: buildSelectionPrompt(companyName, runDate, input.articles),
        maxTokens: 2000,
      });
      if (res.status !== "completed" || !res.output) {
        throw new Error(res.error?.message ?? `model run ended as ${res.status}`);
      }
      const selected = parseSelection(res.output);
      ctx.logger.info("selection done", { count: selected.length });
      return goto("illustrate", { selected });
    } catch (err) {
      if (ctx.attempts + 1 < 3) return retry({ delayMs: 1000 });
      return fail(`select failed: ${String(err)}`);
    }
  },
});

const illustrate = defineStep({
  name: "illustrate",
  next: ["publish"],
  canFail: true,
  async run(input: { selected: SelectedArticle[] }, ctx: AgentExecutionContext<RoundupShared>) {
    const prefix = ctx.shared.get("storagePrefix") ?? "news-roundup/company/";
    const runDate = ctx.shared.get("runDate") ?? todayIso();
    try {
      const articles: IllustratedArticle[] = [];
      for (const [i, art] of input.selected.entries()) {
        let imageFileName: string | null = null;
        // Per-article: one inline retry (two attempts), then degrade to a text-only card.
        for (let attempt = 0; attempt < 2 && imageFileName === null; attempt++) {
          try {
            const gen = await ctx.sapiom.contentGeneration.images.create({ prompt: art.imagePrompt });
            const url = gen.images?.[0]?.url;
            if (!url) throw new Error("no image in generation result");
            const res = await fetch(url);
            if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
            const bytes = new Uint8Array(await res.arrayBuffer());
            const fileName = imageStorageName(prefix, runDate, i + 1);
            await uploadPublicFile(ctx.sapiom, { fileName, contentType: "image/png", bytes });
            imageFileName = fileName;
          } catch (err) {
            ctx.logger.warn("image failed", { article: art.title, attempt, err: String(err) });
          }
        }
        articles.push({ title: art.title, sourceUrl: art.url, summary: art.summary, imageFileName });
      }
      ctx.logger.info("illustrations done", {
        withImage: articles.filter((a) => a.imageFileName !== null).length,
        total: articles.length,
      });
      return goto("publish", { articles });
    } catch (err) {
      if (ctx.attempts + 1 < 3) return retry({ delayMs: 1000 });
      return fail(`illustrate failed: ${String(err)}`);
    }
  },
});

const publish = defineStep({
  name: "publish",
  next: [],
  terminal: true,
  canFail: true,
  async run(input: { articles: IllustratedArticle[] }, ctx: AgentExecutionContext<RoundupShared>) {
    const companyName = ctx.shared.get("companyName") ?? "";
    const companySlug = ctx.shared.get("companySlug") ?? "company";
    const runDate = ctx.shared.get("runDate") ?? todayIso();
    const prefix = ctx.shared.get("storagePrefix") ?? `news-roundup/${companySlug}/`;
    try {
      // 1. Durable copy of the dated page.
      const pageHtml = buildRoundupPage({ companyName, runDate, articles: input.articles });
      await uploadPublicFile(ctx.sapiom, {
        fileName: pageStorageName(prefix, runDate),
        contentType: "text/html",
        bytes: new TextEncoder().encode(pageHtml),
      });
      // 2. Full inventory — the sandbox is rebuilt from storage every run.
      const stored = await listFilesByPrefix(ctx.sapiom, prefix);
      // 3. Find-or-create the site sandbox.
      const sandboxName = `news-roundup-${companySlug}`;
      let sandbox;
      try {
        const info = await ctx.sapiom.sandboxes.get(sandboxName);
        ctx.logger.info("sandbox found", { name: sandboxName, status: info.status });
        if (info.status !== "running") throw new Error(`sandbox status ${info.status}`);
        sandbox = ctx.sapiom.sandboxes.attach(sandboxName);
      } catch (err) {
        // Expired/missing sandbox is the normal weekly path; the reason distinguishes
        // not-found from auth/network failures in the execution logs.
        ctx.logger.warn("creating sandbox", { name: sandboxName, reason: String(err) });
        sandbox = await ctx.sapiom.sandboxes.create({ name: sandboxName, ttl: "24h", tier: "xs", port: SITE_PORT });
      }
      // 4. Mirror storage into site/ (pages/... and images/...).
      for (const f of stored) {
        const rel = f.fileName.slice(prefix.length);
        const bytes = await downloadFileBytes(ctx.sapiom, f.fileId);
        await sandbox.uploadFile(`site/${rel}`, bytes);
      }
      // 5. Index + server, then (re)start.
      const dates = roundupDatesFromFileNames(stored.map((f) => f.fileName), prefix);
      await sandbox.uploadFile("site/index.html", buildIndexPage(companyName, dates));
      await sandbox.uploadFile("site/server.mjs", SERVER_JS);
      const deploy = await sandbox.deployPreview({ start: "node site/server.mjs", port: SITE_PORT });
      if (!deploy.url || deploy.status !== "deployed") {
        throw new Error(`deployPreview ${deploy.status}: ${deploy.logs.slice(-500)}`);
      }
      const siteUrl = deploy.url.replace(/\/+$/, "");
      const imagesPrefix = `${prefix}images/`;
      ctx.logger.info("published", { siteUrl, files: stored.length });
      return terminate({
        status: "published",
        siteUrl,
        pageUrl: `${siteUrl}/pages/${runDate}.html`,
        articles: input.articles.map((a) => ({
          title: a.title,
          sourceUrl: a.sourceUrl,
          summary: a.summary,
          imageUrl: a.imageFileName ? `${siteUrl}/images/${a.imageFileName.slice(imagesPrefix.length)}` : null,
        })),
      });
    } catch (err) {
      if (ctx.attempts + 1 < 3) return retry({ delayMs: 2000 });
      return fail(`publish failed: ${String(err)}`);
    }
  },
});

export const agent = defineAgent<{ companyName: string }, RoundupShared>({
  name: "news-roundup",
  entry: "search",
  steps: { search, select, illustrate, publish },
});
