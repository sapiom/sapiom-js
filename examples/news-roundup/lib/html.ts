import type { IllustratedArticle } from "./types.js";

export function pageStorageName(prefix: string, runDate: string): string {
  return `${prefix}pages/${runDate}.html`;
}

export function imageStorageName(prefix: string, runDate: string, n: number): string {
  return `${prefix}images/${runDate}-${n}.png`;
}

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const STYLE = `<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #f5f5f7; color: #1c1c1e; }
  main { max-width: 720px; margin: 0 auto; padding: 2rem 1rem; }
  h1 { font-size: 1.6rem; }
  .card { background: #fff; border-radius: 12px; padding: 1.25rem; margin: 1rem 0; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .card img { max-width: 100%; border-radius: 8px; }
  .card h2 { font-size: 1.15rem; margin: .75rem 0 .5rem; }
  .card p { line-height: 1.5; margin: 0 0 .5rem; }
  a { color: #0a5dc2; }
  ul.dates { list-style: none; padding: 0; } ul.dates li { margin: .5rem 0; }
</style>`;

export function buildRoundupPage(opts: {
  companyName: string;
  runDate: string;
  articles: IllustratedArticle[];
}): string {
  const cards = opts.articles
    .map((a) => {
      const base = a.imageFileName ? a.imageFileName.split("/").pop() : null;
      const img = base ? `<img src="../images/${esc(base)}" alt="${esc(a.title)}">` : "";
      const safeHref = /^https?:\/\//i.test(a.sourceUrl) ? a.sourceUrl : null;
      return `<article class="card">
${img}
<h2>${esc(a.title)}</h2>
<p>${esc(a.summary)}</p>
${safeHref ? `<p><a href="${esc(safeHref)}">Read the full article</a></p>` : ""}
</article>`;
    })
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.companyName)} news roundup — ${opts.runDate}</title>${STYLE}</head>
<body><main>
<p><a href="../index.html">← All roundups</a></p>
<h1>${esc(opts.companyName)} news roundup — ${opts.runDate}</h1>
${cards}
</main></body></html>`;
}

export function roundupDatesFromFileNames(fileNames: string[], prefix: string): string[] {
  const pagePrefix = `${prefix}pages/`;
  const dates = new Set<string>();
  for (const name of fileNames) {
    if (name.startsWith(pagePrefix) && name.endsWith(".html")) {
      dates.add(name.slice(pagePrefix.length, -".html".length));
    }
  }
  return [...dates].sort().reverse();
}

export function buildIndexPage(companyName: string, dates: string[]): string {
  const items = dates
    .map((d) => `<li class="card"><a href="pages/${esc(d)}.html">Roundup of ${esc(d)}</a></li>`)
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(companyName)} news roundups</title>${STYLE}</head>
<body><main>
<h1>${esc(companyName)} news roundups</h1>
<ul class="dates">
${items}
</ul>
</main></body></html>`;
}

/** Dependency-free static server, written into the sandbox as site/server.js. */
export const SERVER_JS = `import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const types = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    let rel = normalize(urlPath).replace(/^[/\\\\]+/, "");
    if (rel === "" || rel === ".") rel = "index.html";
    const file = resolve(join(root, rel));
    if (file !== root && !file.startsWith(root + "/")) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}).listen(port, () => console.log("serving on " + port));
`;
