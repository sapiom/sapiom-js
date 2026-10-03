/**
 * The public docs as the copilot's reference: docs.sapiom.ai publishes `llms.txt` (one line per
 * page) and a markdown twin of every page at `<page url>.md`. Both are fetched live and cached in
 * `doc_cache`, so a docs change reaches the next draft within the TTL and nothing is redeployed.
 *
 * Only URLs under {@link DOCS_ORIGIN} are ever fetched, whatever the model or a customer names.
 * A deployed step uses plain `fetch` (see the Sapiom authoring guide: a `fetch` in a step is
 * ordinary author code); a local trace never touches the network.
 */
import type { Db } from "./db";

export const DOCS_ORIGIN = "https://docs.sapiom.ai";
export const INDEX_URL = `${DOCS_ORIGIN}/llms.txt`;

/** How long a cached page or index is served before it is fetched again. */
export const TTL_MS = 60 * 60 * 1000;
/** Characters of one page kept in the cache and the prompt. */
export const MAX_PAGE_CHARS = 12_000;
export const TRUNCATION_NOTE = "\n\n[page truncated]";
const FETCH_TIMEOUT_MS = 5000;
/** Bytes read from one response: a page needs at most 4 bytes per kept character, plus margin. */
export const MAX_PAGE_BYTES = MAX_PAGE_CHARS * 4 + 1024;
/** The index lists every page, so it gets a larger bound. */
export const MAX_INDEX_BYTES = 1024 * 1024;

export interface DocEntry {
  title: string;
  /** The page URL as llms.txt lists it, without `.md`. */
  url: string;
  description: string;
}

/** Returns the body of the URL it is given, or throws. Injected so tests never hit the network. */
export type Fetcher = (url: string) => Promise<string>;

export interface DocsDeps {
  fetcher: Fetcher;
  now?: () => Date;
}

/** True only for https URLs on the docs origin (no credentials, no other host or port). */
export function isDocsUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      u.host === new URL(DOCS_ORIGIN).host &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}

/** The page URL without a trailing `.md`, query or fragment: the key pages are cited and cached by. */
export function canonicalPageUrl(raw: string): string | null {
  if (!isDocsUrl(raw)) return null;
  const u = new URL(raw);
  const path = u.pathname.replace(/\.md$/, "").replace(/\/+$/, "");
  return path ? `${DOCS_ORIGIN}${path}` : null;
}

const ENTRY = /^\s*[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)\s*(?::\s*(.*))?$/;

/** The `- [Title](url): description` lines of llms.txt. Entries off the docs origin are dropped. */
export function parseLlmsTxt(text: string): DocEntry[] {
  const seen = new Set<string>();
  const entries: DocEntry[] = [];
  for (const line of text.split("\n")) {
    const m = ENTRY.exec(line);
    if (!m) continue;
    const url = canonicalPageUrl(m[2]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    entries.push({
      title: m[1].trim(),
      url,
      description: (m[3] ?? "").trim(),
    });
  }
  return entries;
}

/** The index as the selection prompt shows it: one line per page. */
export function renderIndex(entries: readonly DocEntry[]): string {
  return entries
    .map(
      (e) =>
        `${e.url} | ${e.title}${e.description ? `: ${e.description}` : ""}`,
    )
    .join("\n");
}

/** The real fetcher. Redirects are refused so a response can never come from another origin. */
export const httpFetcher: Fetcher = async (url) => {
  if (!isDocsUrl(url))
    throw new Error(`refusing to fetch outside ${DOCS_ORIGIN}`);
  const res = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "text/markdown, text/plain;q=0.9" },
  });
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
  return readCapped(res, url === INDEX_URL ? MAX_INDEX_BYTES : MAX_PAGE_BYTES);
};

/** Reads at most `maxBytes` of the body and cancels the rest, so a huge or endless body costs nothing. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  if (size >= maxBytes) await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(Math.min(size, maxBytes));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, all.length - at);
    all.set(part, at);
    at += part.length;
    if (at >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

const LOCAL_INDEX = [
  "- [Deploy an agent](https://docs.sapiom.ai/guides/deploy): Deploy a project and inspect its first run.",
  "- [Web Scraping](https://docs.sapiom.ai/capabilities/scraping): Read pages as clean markdown or HTML.",
].join("\n");

/** What a local trace uses: a two-page index and stub pages, with no network. */
export const localFetcher: Fetcher = async (url) =>
  url === INDEX_URL
    ? LOCAL_INDEX
    : `# Stub page\n\nLocal trace: ${url} was not fetched.`;

let override: Fetcher | undefined;

/** Test hook: route every `docsDeps` through `fetcher` (undefined restores the defaults). */
export function setDocsFetcher(fetcher: Fetcher | undefined): void {
  override = fetcher;
}

/** `httpFetcher` on a deployed run, `localFetcher` on a local trace. */
export function docsDeps(ctx: { isLocalTrace?: boolean }): DocsDeps {
  return {
    fetcher: override ?? (ctx.isLocalTrace ? localFetcher : httpFetcher),
  };
}

/**
 * The cached body for `key` if it is fresh; otherwise `load()` stored under `key`. When the load
 * fails and an expired copy exists, the expired copy is served: a docs outage then costs nothing.
 */
async function cached(
  db: Db,
  key: string,
  deps: DocsDeps,
  load: () => Promise<string>,
): Promise<string> {
  const now = (deps.now ?? (() => new Date()))();
  const rows = await db.query<{ body: string; fetched_at: Date }>(
    "select body, fetched_at from doc_cache where url = $1",
    [key],
  );
  const hit = rows[0];
  if (hit && now.getTime() - new Date(hit.fetched_at).getTime() < TTL_MS)
    return hit.body;
  try {
    const body = await load();
    await db.query(
      `insert into doc_cache (url, body, fetched_at) values ($1, $2, $3)
       on conflict (url) do update set body = excluded.body, fetched_at = excluded.fetched_at`,
      [key, body, now],
    );
    return body;
  } catch (err) {
    if (hit) return hit.body;
    throw err;
  }
}

export async function getIndex(db: Db, deps: DocsDeps): Promise<DocEntry[]> {
  // Validated before it is cached: an empty or malformed 200 must not shadow a good copy for the TTL.
  const text = await cached(db, INDEX_URL, deps, async () => {
    const body = await deps.fetcher(INDEX_URL);
    if (parseLlmsTxt(body).length === 0)
      throw new Error("llms.txt lists no pages");
    return body;
  });
  return parseLlmsTxt(text);
}

/** One page's markdown, capped at {@link MAX_PAGE_CHARS}. Throws for a URL off the docs origin. */
export async function getPage(
  db: Db,
  url: string,
  deps: DocsDeps,
): Promise<string> {
  const page = canonicalPageUrl(url);
  if (!page) throw new Error(`not a docs page: ${url}`);
  return cached(db, page, deps, async () => {
    const body = (await deps.fetcher(`${page}.md`)).trim();
    return body.length > MAX_PAGE_CHARS
      ? body.slice(0, MAX_PAGE_CHARS) + TRUNCATION_NOTE
      : body;
  });
}
