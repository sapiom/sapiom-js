/**
 * `search` capability — find information across the web and beyond.
 *
 * This is the home for Sapiom's search primitives: searching the web, reading the
 * contents of a page, and looking up professional email addresses. It offers
 * `webSearch` (search the web), `scrape` (read a page), and `emailSearch` (find,
 * verify, and discover professional email addresses); more operations follow.
 *
 *   import { search } from "@sapiom/tools";        // ambient auth
 *   const hits = await search.webSearch({ query: "what is an LLM agent?" });
 *   hits.answer;     // a synthesized answer
 *   const page = await search.scrape({ url: "https://example.com" });
 *   page.markdown;   // the page content as markdown
 *   const found = await search.emailSearch.findEmail({
 *     domain: "example.com", fullName: "Ada Lovelace",
 *   });
 *   found.email;     // the discovered email, or null when not found
 *
 * Or via an explicit client: `createClient({ apiKey }).search.webSearch(...)`.
 *
 * Every operation here is **routed**: it goes through the shared
 * {@link capabilityCall} seam to `POST /v1/capabilities/<id>` on the single Core
 * base URL (SAP-1116). The dotted capability id (`web.scrape`, `web.search`,
 * `email.find` / `email.verify` / `email.domain.search`) appears only on the wire —
 * the public verb names and shapes below are unchanged. Failed requests throw
 * {@link SearchHttpError} (carries `status` + parsed `body`).
 */
import {
  Transport,
  capabilityCall,
  defaultTransport,
  resolveCoreBaseUrl,
} from "../_client/index.js";
import { SearchHttpError } from "./errors.js";

export { SearchHttpError };

/** Build the capability-specific error the routed call throws on a non-2xx. */
const searchError = (message: string, status: number, body: unknown): Error =>
  new SearchHttpError(message, status, body);

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

// ----- Internal response shapes (the router's normalized scrape DTO) -----

interface RawMetadata {
  // May arrive as an array on some pages; normalized to a single string.
  title?: string | string[];
  description?: string | string[];
  language?: string;
  sourceURL?: string;
  statusCode?: number;
  [key: string]: unknown;
}

/**
 * The router's normalized `web.scrape` response. The `{ success, data }` Firecrawl
 * envelope is gone — the router's adapter unwraps it and returns the flat shape
 * below (with `servedBy` stripped at the public boundary). `metadata` is the raw
 * provider metadata, so {@link mapMetadata} still normalizes its key shapes.
 */
interface RawScrapeResponse {
  url?: string;
  markdown?: string;
  html?: string;
  rawHtml?: string;
  screenshot?: string;
  // The router doesn't surface page links today; mapped defensively if it ever does.
  links?: string[];
  metadata?: RawMetadata;
  [key: string]: unknown;
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
  // Unrequested formats come back null; treat null as absent (`!=`) so each
  // format field is present only when it was actually returned.
  return {
    url: raw.url ?? url,
    ...(raw.markdown != null && { markdown: raw.markdown }),
    ...(raw.html != null && { html: raw.html }),
    ...(raw.rawHtml != null && { rawHtml: raw.rawHtml }),
    ...(raw.screenshot != null && { screenshot: raw.screenshot }),
    ...(raw.links != null && { links: raw.links }),
    metadata: mapMetadata(raw.metadata),
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
  baseUrl: string = resolveCoreBaseUrl(),
): Promise<ScrapeResult> {
  // `!= null` so an optional explicitly passed as null (a JS caller bypassing the
  // types) is treated as absent rather than forwarded as a null field.
  const body: Record<string, unknown> = { url: input.url };
  if (input.formats != null) body.formats = input.formats;
  if (input.onlyMainContent != null)
    body.onlyMainContent = input.onlyMainContent;
  if (input.waitFor != null) body.waitFor = input.waitFor;

  const raw = await capabilityCall<RawScrapeResponse>("web.scrape", body, {
    transport,
    baseUrl,
    makeError: searchError,
    errorPrefix: "Failed to scrape",
  });
  return mapScrape(input.url, raw);
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
  baseUrl: string = resolveCoreBaseUrl(),
): Promise<WebSearchResponse> {
  // `!= null` so an optional explicitly passed as null (a JS caller bypassing the
  // types) is treated as absent rather than forwarded as a null field.
  const body: Record<string, unknown> = {
    query: input.query,
    intent: input.intent ?? "answer",
  };
  if (input.depth != null) body.depth = input.depth;

  const raw = await capabilityCall<RawWebSearchResponse>("web.search", body, {
    transport,
    baseUrl,
    makeError: searchError,
    errorPrefix: "Failed to search the web",
  });
  return mapWebSearch(input.query, raw);
}

// ----- search.emailSearch -----
//
// Three operations for working with professional email addresses: find an email
// for a known person, verify an address is deliverable, and discover the emails
// published at a company domain. Each routes to its own dotted capability id
// (`email.find` / `email.verify` / `email.domain.search`); the router's normalized
// response is already the SDK's camelCase result shape, so the mappers below are a
// defensive null-normalizing pass, not a snake→camel translation.

// ----- emailSearch.findEmail -----

export interface FindEmailInput {
  /** Company domain to search at, e.g. `"example.com"`. Provide this or `company`. */
  domain?: string;
  /** Company name, as an alternative to `domain`. Provide this or `domain`. */
  company?: string;
  /** Person's first name. Provide with `lastName`, or use `fullName`. */
  firstName?: string;
  /** Person's last name. Provide with `firstName`, or use `fullName`. */
  lastName?: string;
  /** Person's full name, as an alternative to `firstName` + `lastName`. */
  fullName?: string;
}

export interface FindEmailResult {
  /** The discovered email address, or `null` when none was found. */
  email: string | null;
  /** Confidence score (0–100) that the email is correct. */
  score?: number;
  /** First name associated with the result. */
  firstName?: string;
  /** Last name associated with the result. */
  lastName?: string;
  /** Job title / position associated with the result. */
  position?: string;
  /** Company associated with the result. */
  company?: string;
  /** LinkedIn profile URL associated with the result. */
  linkedinUrl?: string;
  /** Deliverability verification for the discovered email, when available. */
  verification?: { status?: string; date?: string };
}

interface RawFindEmail {
  email?: string | null;
  score?: number;
  firstName?: string | null;
  lastName?: string | null;
  position?: string | null;
  company?: string | null;
  linkedinUrl?: string | null;
  verification?: { status?: string; date?: string };
  [key: string]: unknown;
}

function mapFindEmail(raw: RawFindEmail | undefined): FindEmailResult {
  const d = raw ?? {};
  // `!= null` so fields that come back null (a miss) are treated as absent rather
  // than surfaced as `field: null`.
  return {
    email: d.email != null ? d.email : null,
    ...(d.score != null && { score: d.score }),
    ...(d.firstName != null && { firstName: d.firstName }),
    ...(d.lastName != null && { lastName: d.lastName }),
    ...(d.position != null && { position: d.position }),
    ...(d.company != null && { company: d.company }),
    ...(d.linkedinUrl != null && { linkedinUrl: d.linkedinUrl }),
    ...(d.verification != null && { verification: d.verification }),
  };
}

/**
 * Find a person's professional email address.
 *
 * You must provide enough to identify both the person and where they work:
 * a `domain` OR `company`, AND either a `fullName` OR both `firstName` and
 * `lastName`. Calling without a valid combination throws {@link SearchHttpError}
 * before any request is made.
 *
 * Returns the best match, with `email` set to `null` when none was found. Failed
 * requests throw {@link SearchHttpError}.
 */
export async function findEmail(
  input: FindEmailInput,
  transport: Transport = defaultTransport(),
  baseUrl: string = resolveCoreBaseUrl(),
): Promise<FindEmailResult> {
  // Guard the required combination client-side so an under-specified lookup fails
  // fast and clearly, never as a confusing network round-trip. `!= null` plus a
  // truthiness check rejects null/undefined/empty-string for JS callers. (The
  // router validates the same combination, but the client guard keeps the
  // no-network-on-invalid contract the SDK has always offered.)
  const hasOrg = Boolean(input.domain) || Boolean(input.company);
  const hasPerson =
    Boolean(input.fullName) ||
    (Boolean(input.firstName) && Boolean(input.lastName));
  if (!hasOrg || !hasPerson) {
    throw new SearchHttpError(
      "findEmail requires (domain or company) and (fullName or firstName + lastName)",
      400,
      undefined,
    );
  }

  // Forward only the provided fields (camelCase router DTO). `!= null` keeps a
  // JS-caller's explicit null off the wire.
  const body: Record<string, unknown> = {};
  if (input.domain != null) body.domain = input.domain;
  if (input.company != null) body.company = input.company;
  if (input.firstName != null) body.firstName = input.firstName;
  if (input.lastName != null) body.lastName = input.lastName;
  if (input.fullName != null) body.fullName = input.fullName;

  const raw = await capabilityCall<RawFindEmail>("email.find", body, {
    transport,
    baseUrl,
    makeError: searchError,
    errorPrefix: "Failed to find email",
  });
  return mapFindEmail(raw);
}

// ----- emailSearch.verifyEmail -----

export interface VerifyEmailInput {
  /** The email address to verify. */
  email: string;
}

export interface VerifyEmailResult {
  /** The email address that was verified (echoes the input). */
  email: string;
  /** Overall deliverability status. */
  status?: string;
  /** Verification result classification. */
  result?: string;
  /** Confidence score (0–100) in the verification. */
  score?: number;
  /** Whether the mail server accepted the address at the SMTP level. */
  smtpCheck?: boolean;
  /** Whether the domain accepts mail for any address (so a positive is weak). */
  acceptAll?: boolean;
  /** Whether the address belongs to a disposable email provider. */
  disposable?: boolean;
  /** Whether the address belongs to a public webmail provider. */
  webmail?: boolean;
}

interface RawVerifyEmail {
  email?: string;
  status?: string;
  result?: string;
  score?: number;
  smtpCheck?: boolean;
  acceptAll?: boolean;
  disposable?: boolean;
  webmail?: boolean;
  [key: string]: unknown;
}

function mapVerifyEmail(
  email: string,
  raw: RawVerifyEmail | undefined,
): VerifyEmailResult {
  const d = raw ?? {};
  return {
    email: d.email ?? email,
    ...(d.status != null && { status: d.status }),
    ...(d.result != null && { result: d.result }),
    ...(d.score != null && { score: d.score }),
    ...(d.smtpCheck != null && { smtpCheck: d.smtpCheck }),
    ...(d.acceptAll != null && { acceptAll: d.acceptAll }),
    ...(d.disposable != null && { disposable: d.disposable }),
    ...(d.webmail != null && { webmail: d.webmail }),
  };
}

/**
 * Verify that an email address is deliverable — returns a status, confidence
 * score, SMTP/accept-all checks, and disposable/webmail flags. Use it before
 * sending to avoid bounces.
 *
 * Failed requests throw {@link SearchHttpError}.
 */
export async function verifyEmail(
  input: VerifyEmailInput,
  transport: Transport = defaultTransport(),
  baseUrl: string = resolveCoreBaseUrl(),
): Promise<VerifyEmailResult> {
  if (!input.email) {
    throw new SearchHttpError("verifyEmail requires an email", 400, undefined);
  }
  const raw = await capabilityCall<RawVerifyEmail>(
    "email.verify",
    { email: input.email },
    {
      transport,
      baseUrl,
      makeError: searchError,
      errorPrefix: "Failed to verify email",
    },
  );
  return mapVerifyEmail(input.email, raw);
}

// ----- emailSearch.domainSearch -----

export interface DomainSearchInput {
  /** Company domain to search, e.g. `"example.com"`. */
  domain: string;
  /** Maximum number of emails to return (max 100, default 10). */
  limit?: number;
  /** Filter by email type. */
  type?: "personal" | "generic";
  /** Filter to one or more seniority levels. */
  seniority?: ("junior" | "senior" | "executive")[];
  /** Filter to one or more departments (e.g. `"engineering"`, `"sales"`). */
  department?: string[];
}

export interface DomainEmail {
  /** The email address. */
  email: string;
  /** Email type (e.g. `"personal"` or `"generic"`). */
  type?: string;
  /** Confidence score (0–100) that the address is valid. */
  confidence?: number;
  /** First name associated with the address. */
  firstName?: string;
  /** Last name associated with the address. */
  lastName?: string;
  /** Job title / position associated with the address. */
  position?: string;
  /** Department associated with the address. */
  department?: string;
  /** Seniority level associated with the address. */
  seniority?: string;
}

export interface DomainSearchResult {
  /** The domain that was searched (echoes the input). */
  domain: string;
  /** The organization name for the domain, when known. */
  organization?: string;
  /** The detected email pattern for the domain (e.g. `"{first}.{last}"`). */
  pattern?: string;
  /** Whether the domain accepts mail for any address. */
  acceptAll?: boolean;
  /** The emails discovered at the domain. */
  emails: DomainEmail[];
}

interface RawDomainEmail {
  email?: string;
  type?: string;
  confidence?: number;
  firstName?: string | null;
  lastName?: string | null;
  position?: string | null;
  department?: string | null;
  seniority?: string | null;
  [key: string]: unknown;
}

interface RawDomainSearch {
  domain?: string;
  organization?: string;
  pattern?: string;
  acceptAll?: boolean;
  emails?: RawDomainEmail[];
  [key: string]: unknown;
}

function mapDomainEmail(raw: RawDomainEmail): DomainEmail {
  return {
    email: raw.email ?? "",
    ...(raw.type != null && { type: raw.type }),
    ...(raw.confidence != null && { confidence: raw.confidence }),
    ...(raw.firstName != null && { firstName: raw.firstName }),
    ...(raw.lastName != null && { lastName: raw.lastName }),
    ...(raw.position != null && { position: raw.position }),
    ...(raw.department != null && { department: raw.department }),
    ...(raw.seniority != null && { seniority: raw.seniority }),
  };
}

function mapDomainSearch(
  domain: string,
  raw: RawDomainSearch | undefined,
): DomainSearchResult {
  const d = raw ?? {};
  const emails = Array.isArray(d.emails) ? d.emails.map(mapDomainEmail) : [];
  return {
    domain: d.domain ?? domain,
    ...(d.organization != null && { organization: d.organization }),
    ...(d.pattern != null && { pattern: d.pattern }),
    ...(d.acceptAll != null && { acceptAll: d.acceptAll }),
    emails,
  };
}

/**
 * Discover the professional emails published at a company domain. Filter the
 * results by `type`, `seniority`, and `department` to home in on the people you
 * care about.
 *
 * Failed requests throw {@link SearchHttpError}.
 */
export async function domainSearch(
  input: DomainSearchInput,
  transport: Transport = defaultTransport(),
  baseUrl: string = resolveCoreBaseUrl(),
): Promise<DomainSearchResult> {
  if (!input.domain) {
    throw new SearchHttpError("domainSearch requires a domain", 400, undefined);
  }
  // Forward only the provided fields. Array filters travel as arrays in the router
  // DTO; an empty array is omitted entirely (no filter), and absent scalars are left off.
  const body: Record<string, unknown> = { domain: input.domain };
  if (input.limit != null) body.limit = input.limit;
  if (input.type != null) body.type = input.type;
  if (input.seniority != null && input.seniority.length > 0)
    body.seniority = input.seniority;
  if (input.department != null && input.department.length > 0)
    body.department = input.department;

  const raw = await capabilityCall<RawDomainSearch>(
    "email.domain.search",
    body,
    {
      transport,
      baseUrl,
      makeError: searchError,
      errorPrefix: "Failed to search domain",
    },
  );
  return mapDomainSearch(input.domain, raw);
}
