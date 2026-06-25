/**
 * `search` capability — find information across the web and beyond.
 *
 * This is the home for Sapiom's search primitives: searching the web, reading the
 * contents of a page, and looking up professional email addresses. The first
 * operation — `scrape`, which reads a page and returns its content — lands here;
 * more operations follow.
 *
 *   import { search } from "@sapiom/tools";        // ambient auth
 *   const page = await search.scrape({ url: "https://example.com" });
 *   page.markdown;   // the page content as markdown
 *
 * Or via an explicit client: `createClient({ apiKey }).search.scrape(...)`.
 *
 * Failed requests throw {@link SearchHttpError} (carries `status` + parsed `body`).
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { SearchHttpError, ensureOk } from "./errors.js";

export { SearchHttpError };

const DEFAULT_BASE_URL =
  process.env.SAPIOM_SCRAPE_URL || "https://firecrawl.services.sapiom.ai";

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
