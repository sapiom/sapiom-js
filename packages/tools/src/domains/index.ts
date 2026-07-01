/**
 * `domains` capability — register domain names and manage their DNS. Check what's
 * available and its price, buy a domain for a year, renew it, list and inspect the
 * domains you own, and start a transfer out. A nested `dns` group creates, reads,
 * updates, and deletes DNS records on a domain you own.
 *
 *   import { domains } from "@sapiom/tools";                 // ambient auth
 *
 *   const [candidate] = await domains.check({ domainNames: ["my-app.dev"] });
 *   if (candidate.available) {
 *     await domains.register({ domainName: "my-app.dev" });  // charges apply
 *     await domains.dns.create({
 *       domainName: "my-app.dev",
 *       type: "A",
 *       host: "",                                            // "" = the root domain
 *       value: "203.0.113.10",
 *     });
 *   }
 *
 * Or via an explicit client: `createClient({ apiKey }).domains.register(...)`.
 *
 * Operations are grouped:
 *   - top-level — check / register / renew / list / get / transferOut
 *   - `dns`     — create / list / get / update / delete DNS records
 *
 * `register` and `renew` charge on success. Failed requests throw
 * {@link DomainsHttpError} (carries `status` + parsed `body`).
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { resolveServiceUrl } from "../_client/service-url.js";
import { ensureOk, DomainsHttpError } from "./errors.js";

export { DomainsHttpError };

const DEFAULT_BASE_URL = resolveServiceUrl(
  "namecom",
  process.env.SAPIOM_DOMAINS_URL,
);

// ===========================================================================
// Public types (camelCase — the single source of truth for what a caller gets)
// ===========================================================================

/** A DNS record type. */
export type DnsRecordType =
  | "A"
  | "AAAA"
  | "ANAME"
  | "CNAME"
  | "MX"
  | "TXT"
  | "SRV"
  | "NS";

export interface CheckInput {
  /** Domain names to check (1–50), e.g. `["my-app.dev", "my-app.io"]`. */
  domainNames: string[];
}

/** Availability and pricing for a single domain name. */
export interface DomainAvailability {
  /** The domain name that was checked. */
  domainName: string;
  /** Whether the domain is available to register. */
  available: boolean;
  /** First-year price as a decimal string (e.g. "12.99"), when available. */
  purchasePrice?: string;
  /** Yearly renewal price as a decimal string, when available. */
  renewalPrice?: string;
  /** Whether this is a premium (higher-priced) domain. */
  premium?: boolean;
}

export interface DomainNameInput {
  /** The domain name, e.g. "my-app.dev". */
  domainName: string;
}

/** A domain. Which fields are populated depends on the call (see each method). */
export interface Domain {
  /** The domain name. */
  domainName: string;
  /** Lifecycle status (e.g. "active", "transferring_out"). */
  status?: string;
  /** ISO-8601 timestamp when the registration expires. */
  expiresAt?: string;
  /** ISO-8601 timestamp when the domain was registered. */
  registeredAt?: string;
  /** First-year price paid, as a decimal string. */
  purchasePrice?: string;
  /** Yearly renewal price, as a decimal string. */
  renewalPrice?: string;
  /** The nameservers set on the domain. */
  nameservers?: string[];
  /** Whether the domain is registrar-locked against transfers. */
  locked?: boolean;
  /** Whether this is a premium domain. */
  premium?: boolean;
  /** The top-level domain (e.g. "dev", "com"). */
  tld?: string;
  /** ISO-8601 timestamp from which the domain becomes eligible to transfer out, or `null` if already eligible. */
  transferEligibleAt?: string | null;
}

/** The result of starting a transfer out — includes the auth code for the new registrar. */
export interface DomainTransfer {
  /** The domain name being transferred. */
  domainName: string;
  /** Authorization code to give the receiving registrar to complete the transfer. */
  authCode?: string;
  /** Human-readable instructions for completing the transfer. */
  transferInstructions?: string;
}

export interface CreateDnsRecordInput {
  /** The domain to add the record to. */
  domainName: string;
  /** Record type. */
  type: DnsRecordType;
  /** Host — `""` for the root domain (@), or a subdomain like "www" or "api". */
  host: string;
  /** Record value — an IP for A/AAAA, a hostname for CNAME/MX, text for TXT, etc. */
  value: string;
  /** Time-to-live in seconds (minimum 300; defaults to 300). */
  ttl?: number;
  /** Priority — required for MX, optional for others. */
  priority?: number;
}

export interface UpdateDnsRecordInput {
  /** The domain the record belongs to. */
  domainName: string;
  /** The record to update. */
  recordId: string;
  /** New record type. */
  type?: DnsRecordType;
  /** New host. */
  host?: string;
  /** New value. */
  value?: string;
  /** New TTL in seconds (minimum 300). */
  ttl?: number;
  /** New priority. */
  priority?: number;
}

export interface DnsRecordRef {
  /** The domain the record belongs to. */
  domainName: string;
  /** The record identifier. */
  recordId: string;
}

/** A DNS record on a domain you own. */
export interface DnsRecord {
  /** The record identifier — pass to `dns.get` / `dns.update` / `dns.delete`. */
  recordId: string;
  /** The domain the record belongs to. */
  domainName: string;
  /** Record type. */
  type: DnsRecordType;
  /** Host — `""` for the root domain. */
  host: string;
  /** Fully-qualified name of the record (host + domain). */
  fqdn?: string;
  /** Record value. */
  value: string;
  /** Time-to-live in seconds. */
  ttl: number;
  /** Priority, when set (MX/SRV). */
  priority?: number;
  /** ISO-8601 timestamp when the record was created. */
  createdAt?: string;
}

// ===========================================================================
// Internal request/response shapes + mappers
//
// Each map* helper builds a clean public object field-by-field (never a
// passthrough spread), so the exported types are the single source of truth for
// what a caller receives.
// ===========================================================================

interface RawAvailability {
  domainName: string;
  available: boolean;
  purchasePrice?: string;
  renewalPrice?: string;
  premium?: boolean;
}

interface RawCheckResponse {
  results: RawAvailability[];
}

interface RawDomain {
  domainName: string;
  status?: string;
  expiresAt?: string;
  registeredAt?: string;
  purchasePrice?: string;
  renewalPrice?: string | null;
  nameservers?: string[];
  locked?: boolean;
  premium?: boolean;
  tld?: string;
  transferEligibleAt?: string | null;
}

interface RawDomainTransfer {
  domainName: string;
  authCode?: string;
  transferInstructions?: string;
}

interface RawDnsRecord {
  id: string;
  domainName: string;
  type: DnsRecordType;
  host: string;
  fqdn?: string;
  value: string;
  ttl: number;
  priority?: number;
  createdAt?: string;
}

function mapAvailability(raw: RawAvailability): DomainAvailability {
  return {
    domainName: raw.domainName,
    available: raw.available,
    ...(raw.purchasePrice != null && { purchasePrice: raw.purchasePrice }),
    ...(raw.renewalPrice != null && { renewalPrice: raw.renewalPrice }),
    ...(raw.premium !== undefined && { premium: raw.premium }),
  };
}

function mapDomain(raw: RawDomain): Domain {
  return {
    domainName: raw.domainName,
    ...(raw.status !== undefined && { status: raw.status }),
    ...(raw.expiresAt !== undefined && { expiresAt: raw.expiresAt }),
    ...(raw.registeredAt !== undefined && { registeredAt: raw.registeredAt }),
    ...(raw.purchasePrice != null && { purchasePrice: raw.purchasePrice }),
    ...(raw.renewalPrice != null && { renewalPrice: raw.renewalPrice }),
    ...(raw.nameservers !== undefined && { nameservers: raw.nameservers }),
    ...(raw.locked !== undefined && { locked: raw.locked }),
    ...(raw.premium !== undefined && { premium: raw.premium }),
    ...(raw.tld !== undefined && { tld: raw.tld }),
    ...(raw.transferEligibleAt !== undefined && {
      transferEligibleAt: raw.transferEligibleAt,
    }),
  };
}

function mapDomainTransfer(raw: RawDomainTransfer): DomainTransfer {
  return {
    domainName: raw.domainName,
    ...(raw.authCode != null && { authCode: raw.authCode }),
    ...(raw.transferInstructions != null && {
      transferInstructions: raw.transferInstructions,
    }),
  };
}

function mapDnsRecord(raw: RawDnsRecord): DnsRecord {
  return {
    recordId: raw.id,
    domainName: raw.domainName,
    type: raw.type,
    host: raw.host,
    ...(raw.fqdn != null && { fqdn: raw.fqdn }),
    value: raw.value,
    ttl: raw.ttl,
    ...(raw.priority != null && { priority: raw.priority }),
    ...(raw.createdAt != null && { createdAt: raw.createdAt }),
  };
}

// ===========================================================================
// Guards & request shaping
// ===========================================================================

/**
 * Guard a required string (a domain name / record id) client-side, so a JS caller
 * passing null / undefined / "" gets a clear error instead of a confusing request
 * to a malformed path.
 */
function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainsHttpError(
      `${label} is required and must be a non-empty string`,
      400,
      undefined,
    );
  }
  return value;
}

/** Percent-encode a single path segment (a domain name is one segment; dots are preserved). */
function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

/** Copy a value onto `body` only when it is neither undefined nor null. */
function set(body: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) body[key] = value;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

// ===========================================================================
// Domains — operations
// ===========================================================================

/**
 * Check whether one or more domain names are available and get their price. Free.
 * Use this first, in a workflow step that turns an idea into candidate names,
 * before deciding what to `register`.
 *
 * @param input - `{ domainNames }` — 1 to 50 names to check.
 * @returns One availability result per name (with pricing when available).
 * @throws {DomainsHttpError} on a non-2xx response.
 *
 * @example
 * const results = await domains.check({ domainNames: ["my-app.dev", "my-app.io"] });
 * const buyable = results.filter((r) => r.available);
 */
export async function check(
  input: CheckInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<DomainAvailability[]> {
  const domainNames = input?.domainNames;
  if (!Array.isArray(domainNames) || domainNames.length === 0) {
    throw new DomainsHttpError(
      "domainNames is required and must be a non-empty array",
      400,
      undefined,
    );
  }
  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/domains/check`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ domainNames }),
    }),
    "Failed to check domain availability",
  );
  const raw = (await res.json()) as RawCheckResponse;
  return raw.results.map(mapAvailability);
}

/**
 * Register (buy) a domain for one year. Charges apply on success and the purchase
 * is not reversible. Use in a workflow step to acquire a brand's domain before
 * configuring DNS or email for it; confirm availability and price with `check`
 * first.
 *
 * @param input - `{ domainName }` — the domain to register.
 * @returns The newly registered domain.
 * @throws {DomainsHttpError} on a non-2xx response (e.g. already registered, or a price change).
 *
 * @example
 * const domain = await domains.register({ domainName: "my-app.dev" });
 */
export async function register(
  input: DomainNameInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Domain> {
  const domainName = assertString(input?.domainName, "domainName");
  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/domains`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ domainName }),
    }),
    `Failed to register domain '${domainName}'`,
  );
  return mapDomain((await res.json()) as RawDomain);
}

/**
 * Renew a domain you own for one more year. Charges apply on success. Use in a
 * workflow step that keeps a domain from expiring; read the renewal price from
 * `get` first if you want to check it.
 *
 * @param input - `{ domainName }` — the domain to renew.
 * @returns The domain with its updated expiry.
 * @throws {DomainsHttpError} on a non-2xx response (e.g. not owned, or a price change).
 *
 * @example
 * const domain = await domains.renew({ domainName: "my-app.dev" });
 */
export async function renew(
  input: DomainNameInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Domain> {
  const domainName = assertString(input?.domainName, "domainName");
  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/domains/${encodeSegment(domainName)}/renew`,
      { method: "POST", headers: JSON_HEADERS, body: "{}" },
    ),
    `Failed to renew domain '${domainName}'`,
  );
  return mapDomain((await res.json()) as RawDomain);
}

/**
 * List the domains you own. Free. Use in a workflow step to discover or iterate
 * over the domains available to configure.
 *
 * @returns Your domains, each with status, expiry, and renewal price.
 * @throws {DomainsHttpError} on a non-2xx response.
 *
 * @example
 * const owned = await domains.list();
 */
export async function list(
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Domain[]> {
  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/domains`),
    "Failed to list domains",
  );
  const raw = (await res.json()) as RawDomain[];
  return raw.map(mapDomain);
}

/**
 * Get full details for a domain you own — nameservers, lock status, renewal price,
 * and transfer eligibility. Free. Use in a workflow step before changing DNS or
 * starting a transfer, when you need the domain's current state.
 *
 * @param input - `{ domainName }` — the domain to look up.
 * @returns The domain's details.
 * @throws {DomainsHttpError} on a non-2xx response (e.g. not owned).
 *
 * @example
 * const detail = await domains.get({ domainName: "my-app.dev" });
 */
export async function get(
  input: DomainNameInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Domain> {
  const domainName = assertString(input?.domainName, "domainName");
  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/domains/${encodeSegment(domainName)}`),
    `Failed to get domain '${domainName}'`,
  );
  return mapDomain((await res.json()) as RawDomain);
}

/**
 * Start transferring a domain you own out to another registrar. Returns an auth
 * code to hand the receiving registrar. Disruptive — this unlocks the domain and
 * begins the transfer; use in a workflow step only when you intend to move the
 * domain away.
 *
 * @param input - `{ domainName }` — the domain to transfer out.
 * @returns The auth code and transfer instructions.
 * @throws {DomainsHttpError} on a non-2xx response (e.g. not owned, or still transfer-locked).
 *
 * @example
 * const { authCode } = await domains.transferOut({ domainName: "my-app.dev" });
 */
export async function transferOut(
  input: DomainNameInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<DomainTransfer> {
  const domainName = assertString(input?.domainName, "domainName");
  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/domains/${encodeSegment(domainName)}`,
      { method: "DELETE" },
    ),
    `Failed to transfer out domain '${domainName}'`,
  );
  return mapDomainTransfer((await res.json()) as RawDomainTransfer);
}

// ===========================================================================
// DNS records — operations
// ===========================================================================

/**
 * Create a DNS record on a domain you own. Free. Use in a workflow step to point a
 * domain at a host (A/AAAA/CNAME), route its email (MX), or add verification text
 * (TXT). Use `host: ""` for the root domain, or a subdomain like "www".
 *
 * @param input - `{ domainName, type, host, value, ttl?, priority? }`.
 * @returns The created record (with its `recordId`).
 * @throws {DomainsHttpError} on a non-2xx response.
 *
 * @example
 * const record = await domains.dns.create({
 *   domainName: "my-app.dev",
 *   type: "A",
 *   host: "",
 *   value: "203.0.113.10",
 * });
 */
export async function createDnsRecord(
  input: CreateDnsRecordInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<DnsRecord> {
  const domainName = assertString(input?.domainName, "domainName");
  const body: Record<string, unknown> = {
    type: input.type,
    host: input.host,
    value: input.value,
  };
  set(body, "ttl", input.ttl);
  set(body, "priority", input.priority);

  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/domains/${encodeSegment(domainName)}/records`,
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) },
    ),
    `Failed to create DNS record on '${domainName}'`,
  );
  return mapDnsRecord((await res.json()) as RawDnsRecord);
}

/**
 * List the DNS records on a domain you own. Free. Use in a workflow step to read
 * the current records (e.g. to find a `recordId` to update or delete).
 *
 * @param input - `{ domainName }` — the domain whose records to list.
 * @returns The domain's DNS records.
 * @throws {DomainsHttpError} on a non-2xx response.
 *
 * @example
 * const records = await domains.dns.list({ domainName: "my-app.dev" });
 */
export async function listDnsRecords(
  input: DomainNameInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<DnsRecord[]> {
  const domainName = assertString(input?.domainName, "domainName");
  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/domains/${encodeSegment(domainName)}/records`,
    ),
    `Failed to list DNS records on '${domainName}'`,
  );
  const raw = (await res.json()) as RawDnsRecord[];
  return raw.map(mapDnsRecord);
}

/**
 * Get a single DNS record on a domain you own. Free. Use in a workflow step when
 * you have a `recordId` and need the record's current values.
 *
 * @param input - `{ domainName, recordId }`.
 * @returns The DNS record.
 * @throws {DomainsHttpError} on a non-2xx response (e.g. record not found).
 *
 * @example
 * const record = await domains.dns.get({ domainName: "my-app.dev", recordId });
 */
export async function getDnsRecord(
  input: DnsRecordRef,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<DnsRecord> {
  const domainName = assertString(input?.domainName, "domainName");
  const recordId = assertString(input?.recordId, "recordId");
  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/domains/${encodeSegment(domainName)}/records/${encodeSegment(recordId)}`,
    ),
    `Failed to get DNS record '${recordId}'`,
  );
  return mapDnsRecord((await res.json()) as RawDnsRecord);
}

/**
 * Update a DNS record on a domain you own. Free. Provide only the fields you want
 * to change. Use in a workflow step to repoint a record (e.g. change an A record's
 * IP) without recreating it.
 *
 * @param input - `{ domainName, recordId, type?, host?, value?, ttl?, priority? }`.
 * @returns The updated record.
 * @throws {DomainsHttpError} on a non-2xx response.
 *
 * @example
 * const updated = await domains.dns.update({
 *   domainName: "my-app.dev",
 *   recordId,
 *   value: "198.51.100.7",
 * });
 */
export async function updateDnsRecord(
  input: UpdateDnsRecordInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<DnsRecord> {
  const domainName = assertString(input?.domainName, "domainName");
  const recordId = assertString(input?.recordId, "recordId");
  const body: Record<string, unknown> = {};
  set(body, "type", input.type);
  set(body, "host", input.host);
  set(body, "value", input.value);
  set(body, "ttl", input.ttl);
  set(body, "priority", input.priority);

  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/domains/${encodeSegment(domainName)}/records/${encodeSegment(recordId)}`,
      { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) },
    ),
    `Failed to update DNS record '${recordId}'`,
  );
  return mapDnsRecord((await res.json()) as RawDnsRecord);
}

/**
 * Delete a DNS record from a domain you own. Free. Use in a workflow step to
 * remove a record you no longer need.
 *
 * @param input - `{ domainName, recordId }`.
 * @returns Nothing.
 * @throws {DomainsHttpError} on a non-2xx response.
 *
 * @example
 * await domains.dns.delete({ domainName: "my-app.dev", recordId });
 */
async function deleteDnsRecord(
  input: DnsRecordRef,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<void> {
  const domainName = assertString(input?.domainName, "domainName");
  const recordId = assertString(input?.recordId, "recordId");
  await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/domains/${encodeSegment(domainName)}/records/${encodeSegment(recordId)}`,
      { method: "DELETE" },
    ),
    `Failed to delete DNS record '${recordId}'`,
  );
}

export { deleteDnsRecord };

/**
 * The `dns` sub-namespace, so `domains.dns.create(...)` (and `list` / `get` /
 * `update` / `delete`) reads the same whether imported from the barrel or used on
 * a client. `delete` maps to {@link deleteDnsRecord} (its own name is reserved).
 */
export const dns = {
  create: createDnsRecord,
  list: listDnsRecords,
  get: getDnsRecord,
  update: updateDnsRecord,
  delete: deleteDnsRecord,
};
