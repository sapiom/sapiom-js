/**
 * `search` capability — find information across the web and beyond.
 *
 * This is the home for Sapiom's search primitives: searching the web, reading the
 * contents of a page, and looking up professional email addresses. Today it
 * offers `webSearch` (search the web) and `scrape` (read a page); more operations
 * follow.
 *
 *   import { search } from "@sapiom/tools";        // ambient auth
 *   const hits = await search.webSearch({ query: "what is an LLM agent?" });
 *   hits.answer;     // a synthesized answer
 *   const page = await search.scrape({ url: "https://example.com" });
 *   page.markdown;   // the page content as markdown
 *
 * Or via an explicit client: `createClient({ apiKey }).search.webSearch(...)`.
 *
 * Failed requests throw {@link SearchHttpError} (carries `status` + parsed `body`).
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { SearchHttpError, ensureOk } from "./errors.js";

export { SearchHttpError };

const DEFAULT_BASE_URL =
  process.env.SAPIOM_SCRAPE_URL || "https://firecrawl.services.sapiom.ai";

const DEFAULT_WEB_SEARCH_BASE_URL =
  process.env.SAPIOM_SEARCH_URL || "https://api.sapiom.ai";

// ----- Types -----

/** Output formats `scrape` can return. Defaults to `["markdown"]`. */
export type ScrapeFormat =
  | "markdown"
  | "html"
  | "rawHtml"
  | "screenshot"
  | "links";

export interface ScrapeInput {
  /** URL of the page to read. */
  url: string;
  /** Which content formats to return. Defaults to `["markdown"]`. */
  formats?: ScrapeFormat[];
  /** Return only the main content, dropping nav/header/footer/ads. */
  onlyMainContent?: boolean;
  /** Milliseconds to wait before reading (for content rendered by JavaScript). */
  waitFor?: number;
}

export interface ScrapeMetadata {
  /** Page title. */
  title?: string;
  /** Page description. */
  description?: string;
  /** Detected page language. */
  language?: string;
  /** The URL the content was read from. */
  sourceUrl?: string;
  /** HTTP status code returned while reading the page. */
  statusCode?: number;
}

export interface ScrapeResult {
  /** The URL that was read (echoes the input). */
  url: string;
  /** Page content as markdown (present when "markdown" was requested). */
  markdown?: string;
  /** Cleaned HTML (present when "html" was requested). */
  html?: string;
  /** Raw HTML (present when "rawHtml" was requested). */
  rawHtml?: string;
  /** Screenshot URL (present when "screenshot" was requested). */
  screenshot?: string;
  /** Links found on the page (present when "links" was requested). */
  links?: string[];
  /** Page metadata (title, description, language, status, …). */
  metadata: ScrapeMetadata;
}

// ----- Internal request/response shapes -----

interface RawMetadata {
  // May arrive as an array on some pages; normalized to a single string.
  title?: string | string[];
  description?: string | string[];
  language?: string;
  sourceURL?: string;
  statusCode?: number;
  [key: string]: unknown;
}

interface RawScrapeData {
  markdown?: string;
  html?: string;
  rawHtml?: string;
  screenshot?: string;
  links?: string[];
  metadata?: RawMetadata;
  [key: string]: unknown;
}

interface RawScrapeResponse {
  success?: boolean;
  data?: RawScrapeData;
}

/** Collapse a field that may be a single value or an array down to one value. */
function firstOf<T>(value: T | T[] | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function mapMetadata(raw: RawMetadata | undefined): ScrapeMetadata {
  const meta = raw ?? {};
  const title = firstOf(meta.title);
  const description = firstOf(meta.description);
  // A field a caller didn't ask for comes back null — treat null as absent (`!=`)
  // so the result only carries fields that were actually populated.
  return {
    ...(title != null && { title }),
    ...(description != null && { description }),
    ...(meta.language != null && { language: meta.language }),
    ...(meta.sourceURL != null && { sourceUrl: meta.sourceURL }),
    ...(meta.statusCode != null && { statusCode: meta.statusCode }),
  };
}

function mapScrape(url: string, raw: RawScrapeResponse): ScrapeResult {
  const data = raw.data ?? {};
  // Unrequested formats come back null; treat null as absent (`!=`) so each
  // format field is present only when it was actually returned.
  return {
    url,
    ...(data.markdown != null && { markdown: data.markdown }),
    ...(data.html != null && { html: data.html }),
    ...(data.rawHtml != null && { rawHtml: data.rawHtml }),
    ...(data.screenshot != null && { screenshot: data.screenshot }),
    ...(data.links != null && { links: data.links }),
    metadata: mapMetadata(data.metadata),
  };
}

// ----- Capability operations -----

/**
 * Read a page and return its content. By default you get markdown; pass `formats`
 * to also (or instead) get HTML, raw HTML, a screenshot, or the page's links.
 *
 * Works on HTML pages and common documents (PDF, DOCX, TXT). Failed requests throw
 * {@link SearchHttpError}.
 */
export async function scrape(
  input: ScrapeInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<ScrapeResult> {
  // `!= null` so an optional explicitly passed as null (a JS caller bypassing the
  // types) is treated as absent rather than forwarded as a null field.
  const body: Record<string, unknown> = { url: input.url };
  if (input.formats != null) body.formats = input.formats;
  if (input.onlyMainContent != null)
    body.onlyMainContent = input.onlyMainContent;
  if (input.waitFor != null) body.waitFor = input.waitFor;

  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v2/scrape`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    "Failed to scrape",
  );
  return mapScrape(input.url, (await res.json()) as RawScrapeResponse);
}

// ----- search.webSearch -----

export interface WebSearchInput {
  /** What to search for. */
  query: string;
  /** How thoroughly to search. Defaults to `"standard"`. */
  depth?: "standard" | "deep";
  /**
   * What you want back. `"answer"` (default) returns a synthesized answer plus
   * supporting results; `"links"` returns a list of relevant results.
   */
  intent?: "answer" | "links";
}

export interface WebSearchResult {
  /** Result title. */
  title: string;
  /** Result URL. */
  url: string;
  /** Short excerpt for the result. */
  snippet: string;
}

export interface WebSearchResponse {
  /** The query that was searched (echoes the input). */
  query: string;
  /** A synthesized answer, when `intent` is `"answer"`. */
  answer?: string;
  /** The results found for the query. */
  results: WebSearchResult[];
}

interface RawWebSearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  [key: string]: unknown;
}

interface RawWebSearchResponse {
  query?: string;
  answer?: string;
  results?: RawWebSearchResult[];
  [key: string]: unknown;
}

function mapWebSearchResult(raw: RawWebSearchResult): WebSearchResult {
  return {
    title: raw.title ?? "",
    url: raw.url ?? "",
    snippet: raw.snippet ?? "",
  };
}

function mapWebSearch(
  query: string,
  raw: RawWebSearchResponse,
): WebSearchResponse {
  // Build the result from only the public fields. A defensive measure: any
  // extra top-level field on the wire (e.g. bookkeeping not meant for callers)
  // is dropped by construction rather than spread through.
  const results = Array.isArray(raw.results)
    ? raw.results.map(mapWebSearchResult)
    : [];
  return {
    query: raw.query ?? query,
    ...(raw.answer != null && { answer: raw.answer }),
    results,
  };
}

/**
 * Search the web. By default you get a synthesized answer plus supporting
 * results; pass `intent: "links"` for a list of relevant results, and
 * `depth: "deep"` for a more thorough search.
 *
 * Failed requests throw {@link SearchHttpError}.
 */
export async function webSearch(
  input: WebSearchInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_WEB_SEARCH_BASE_URL,
): Promise<WebSearchResponse> {
  // `!= null` so an optional explicitly passed as null (a JS caller bypassing the
  // types) is treated as absent rather than forwarded as a null field.
  const body: Record<string, unknown> = {
    query: input.query,
    intent: input.intent ?? "answer",
  };
  if (input.depth != null) body.depth = input.depth;

  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/capabilities/web.search`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      { authHeader: "x-api-key" },
    ),
    "Failed to search the web",
  );
  return mapWebSearch(input.query, (await res.json()) as RawWebSearchResponse);
}
