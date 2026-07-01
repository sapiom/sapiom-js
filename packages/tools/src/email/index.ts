/**
 * `email` capability — programmatic transactional email: create inboxes, send and
 * receive messages, manage sending domains and threads, and register webhooks for
 * inbound events. Each inbox is a real, addressable mailbox your code owns.
 *
 *   import { email } from "@sapiom/tools";                 // ambient auth
 *
 *   const inbox = await email.inboxes.create({ username: "support" });
 *   await email.messages.send(inbox.inboxId, {
 *     to: "customer@example.com",
 *     subject: "Welcome",
 *     text: "Thanks for signing up!",
 *   });
 *
 * Or via an explicit client: `createClient({ apiKey }).email.inboxes.create(...)`.
 *
 * Operations are grouped:
 *   - `inboxes`  — create / list / get / delete mailboxes
 *   - `messages` — send / list / get / reply / replyAll / forward
 *   - `domains`  — register a custom sending domain, verify it, read status
 *   - `threads`  — list / get conversation threads
 *   - `webhooks` — register / delete inbound-event webhooks
 *
 * An `inboxId` is the inbox's email address; message, thread, and domain ids are
 * opaque strings returned by their create/list calls. Failed requests throw
 * {@link EmailHttpError} (carries `status` + parsed `body`).
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { resolveServiceUrl } from "../_client/service-url.js";
import { ensureOk, EmailHttpError } from "./errors.js";

export { EmailHttpError };

const DEFAULT_BASE_URL = resolveServiceUrl(
  "agentmail",
  process.env.SAPIOM_EMAIL_URL,
);

// ===========================================================================
// Shared types
// ===========================================================================

/**
 * A recipient field — a single email address or a list of them. Used by `to`,
 * `cc`, `bcc`, and `replyTo`.
 */
export type Recipients = string | string[];

/** Verification state of a sending domain. */
export type DomainStatus =
  | "NOT_STARTED"
  | "PENDING"
  | "VERIFYING"
  | "VERIFIED"
  | "INVALID"
  | "FAILED";

// ===========================================================================
// Inboxes
// ===========================================================================

export interface CreateInboxInput {
  /** Local part of the address (before the `@`). Generated for you if omitted. */
  username?: string;
  /** A verified custom sending domain to create the address on. Uses the default domain if omitted. */
  domain?: string;
  /** A display name shown to recipients (e.g. "Acme Support"). */
  displayName?: string;
  /** Your own idempotency / correlation key for the inbox. */
  clientId?: string;
}

export interface Inbox {
  /** Unique inbox identifier — this is the inbox's email address. */
  inboxId: string;
  /** The inbox's email address. */
  email: string;
  /** Display name shown to recipients, if set. */
  displayName?: string;
  /** Your idempotency / correlation key, if set at creation. */
  clientId?: string;
  /** ISO-8601 timestamp when the inbox was created. */
  createdAt: string;
  /** ISO-8601 timestamp when the inbox was last updated. */
  updatedAt: string;
}

export interface ListInboxesOptions {
  /** Maximum number of inboxes to return (1–100). */
  limit?: number;
  /** Opaque page cursor from a previous response's `nextPageToken`. */
  pageToken?: string;
}

export interface InboxList {
  /** Number of inboxes on this page. */
  count: number;
  /** Cursor for the next page, if more exist. Pass it back as `pageToken`. */
  nextPageToken?: string;
  /** Inboxes on the current page. */
  inboxes: Inbox[];
}

// ===========================================================================
// Messages & threads
// ===========================================================================

export interface Attachment {
  /** Unique attachment identifier. */
  attachmentId: string;
  /** Original file name, if available. */
  filename?: string;
  /** MIME content type, if available. */
  contentType?: string;
  /** Size in bytes. */
  size: number;
}

export interface Message {
  /** Unique message identifier. */
  messageId: string;
  /** Identifier of the thread this message belongs to. */
  threadId: string;
  /** Identifier of the inbox this message belongs to. */
  inboxId: string;
  /** Sender address. */
  from: string;
  /** Recipient addresses. */
  to: string[];
  /** Carbon-copy addresses, if any. */
  cc?: string[];
  /** Blind carbon-copy addresses, if any. */
  bcc?: string[];
  /** Reply-to addresses, if any. */
  replyTo?: string[];
  /** Subject line, if any. */
  subject?: string;
  /** Short preview of the body. */
  preview?: string;
  /** Plain-text body. */
  text?: string;
  /** HTML body. */
  html?: string;
  /** The plain-text body with quoted reply history removed — the "new" content only. */
  extractedText?: string;
  /** The HTML body with quoted reply history removed — the "new" content only. */
  extractedHtml?: string;
  /** Labels applied to the message. */
  labels: string[];
  /** ISO-8601 timestamp of the message. */
  timestamp: string;
  /** The `messageId` this message is a reply to, if any. */
  inReplyTo?: string;
  /** Message ids referenced by this message (threading chain), if any. */
  references?: string[];
  /** Custom headers on the message, if any. */
  headers?: Record<string, string>;
  /** Attachment metadata, if any. */
  attachments?: Attachment[];
  /** Total size in bytes. */
  size: number;
  /** ISO-8601 timestamp when the record was created. */
  createdAt: string;
  /** ISO-8601 timestamp when the record was last updated. */
  updatedAt: string;
}

/**
 * A message as it appears in a list — metadata only (no `text` / `html` /
 * `extractedText` / `extractedHtml` / `replyTo`). Fetch the full message with
 * `messages.get` to read the body.
 */
export type MessageListItem = Omit<
  Message,
  "text" | "html" | "extractedText" | "extractedHtml" | "replyTo"
>;

export interface MessageList {
  /** Number of messages on this page. */
  count: number;
  /** Cursor for the next page, if more exist. Pass it back as `pageToken`. */
  nextPageToken?: string;
  /** Messages on the current page (metadata only). */
  messages: MessageListItem[];
}

export interface ListMessagesOptions {
  /** Maximum number of messages to return (1–100). */
  limit?: number;
  /** Opaque page cursor from a previous response's `nextPageToken`. */
  pageToken?: string;
}

/** The result of a send / reply / forward — identifies the created message and its thread. */
export interface SendResult {
  /** Identifier of the created message. */
  messageId: string;
  /** Identifier of the thread the message belongs to. */
  threadId: string;
}

export interface SendMessageInput {
  /** Recipient(s). Required. */
  to: Recipients;
  /** Carbon-copy recipient(s). */
  cc?: Recipients;
  /** Blind carbon-copy recipient(s). */
  bcc?: Recipients;
  /** Reply-to address(es). */
  replyTo?: Recipients;
  /** Subject line. */
  subject?: string;
  /** Plain-text body. */
  text?: string;
  /** HTML body. */
  html?: string;
  /** Custom headers. Routing/identity/MIME headers are rejected — use the dedicated fields instead. */
  headers?: Record<string, string>;
  /** Labels to apply to the sent message. */
  labels?: string[];
}

export interface ReplyInput {
  /** Override the recipient(s). Defaults to the original sender if omitted. */
  to?: Recipients;
  /** Carbon-copy recipient(s). */
  cc?: Recipients;
  /** Blind carbon-copy recipient(s). */
  bcc?: Recipients;
  /** Reply-to address(es). */
  replyTo?: Recipients;
  /** Reply to everyone on the original message. */
  replyAll?: boolean;
  /** Plain-text body. */
  text?: string;
  /** HTML body. */
  html?: string;
  /** Custom headers. Routing/identity/MIME headers are rejected — use the dedicated fields instead. */
  headers?: Record<string, string>;
  /** Labels to apply to the reply. */
  labels?: string[];
}

export interface ReplyAllInput {
  /** Reply-to address(es). */
  replyTo?: Recipients;
  /** Plain-text body. */
  text?: string;
  /** HTML body. */
  html?: string;
  /** Custom headers. Routing/identity/MIME headers are rejected — use the dedicated fields instead. */
  headers?: Record<string, string>;
  /** Labels to apply to the reply. */
  labels?: string[];
}

export interface Thread {
  /** Unique thread identifier. */
  threadId: string;
  /** Identifier of the inbox this thread belongs to. */
  inboxId: string;
  /** Labels applied to the thread. */
  labels: string[];
  /** ISO-8601 timestamp of the thread's latest activity. */
  timestamp: string;
  /** ISO-8601 timestamp of the last received message, if any. */
  receivedTimestamp?: string;
  /** ISO-8601 timestamp of the last sent message, if any. */
  sentTimestamp?: string;
  /** Subject line, if any. */
  subject?: string;
  /** Short preview of the latest message. */
  preview?: string;
  /** Distinct sender addresses in the thread. */
  senders: string[];
  /** Distinct recipient addresses in the thread. */
  recipients: string[];
  /** Identifier of the most recent message in the thread. */
  lastMessageId: string;
  /** Number of messages in the thread. */
  messageCount: number;
  /** Total size in bytes. */
  size: number;
  /** Attachment metadata across the thread, if any. */
  attachments?: Attachment[];
  /** ISO-8601 timestamp when the record was created. */
  createdAt: string;
  /** ISO-8601 timestamp when the record was last updated. */
  updatedAt: string;
  /** The messages in the thread, oldest to newest. */
  messages: Message[];
}

/** A thread as it appears in a list — without the `messages` array. */
export type ThreadListItem = Omit<Thread, "messages">;

export interface ThreadList {
  /** Number of threads on this page. */
  count: number;
  /** Cursor for the next page, if more exist. Pass it back as `pageToken`. */
  nextPageToken?: string;
  /** Threads on the current page (without their messages). */
  threads: ThreadListItem[];
}

export interface ListThreadsOptions {
  /** Maximum number of threads to return (1–100). */
  limit?: number;
  /** Opaque page cursor from a previous response's `nextPageToken`. */
  pageToken?: string;
}

// ===========================================================================
// Domains
// ===========================================================================

export interface CreateDomainInput {
  /** Fully-qualified domain to register, e.g. "mail.example.com". Required. */
  domain: string;
  /** Enable bounce/complaint feedback for this domain. Defaults to false. */
  feedbackEnabled?: boolean;
}

/** A DNS record you must publish to verify a domain. */
export interface DomainRecord {
  /** Record type. */
  type: "TXT" | "CNAME" | "MX";
  /** Record name (host). */
  name: string;
  /** Record value. */
  value: string;
  /** Whether the record has been observed as published and valid. */
  status: "MISSING" | "INVALID" | "VALID";
  /** Priority — present only for MX records. */
  priority?: number;
}

export interface Domain {
  /** Unique domain identifier. */
  domainId: string;
  /** The registered domain. */
  domain: string;
  /** Verification status. */
  status: DomainStatus;
  /** Whether bounce/complaint feedback is enabled. */
  feedbackEnabled: boolean;
  /** DNS records to publish to verify the domain. */
  records: DomainRecord[];
  /** ISO-8601 timestamp when the domain was created. */
  createdAt: string;
  /** ISO-8601 timestamp when the domain was last updated (bumps as verification re-checks DNS). */
  updatedAt: string;
}

/**
 * A domain as it appears in a list — without the `status` and `records` fields.
 * Call `domains.get` for the full status and DNS records.
 */
export interface DomainListItem {
  /** Unique domain identifier. */
  domainId: string;
  /** The registered domain. */
  domain: string;
  /** Whether bounce/complaint feedback is enabled. */
  feedbackEnabled: boolean;
  /** ISO-8601 timestamp when the domain was created. */
  createdAt: string;
  /** ISO-8601 timestamp when the domain was last updated. */
  updatedAt: string;
}

// Domain lists are returned in full — not paginated — so there is no page cursor
// (unlike inbox / message / thread lists).
export interface DomainList {
  /** Number of domains. */
  count: number;
  /** Domains (without status/records). */
  domains: DomainListItem[];
}

// ===========================================================================
// Webhooks
// ===========================================================================

export interface CreateWebhookInput {
  /** HTTPS URL to deliver events to. Required. */
  url: string;
  /**
   * The event to subscribe to (e.g. "message.received"), or "*" for all events.
   * Required.
   */
  eventType: string;
}

export interface Webhook {
  /** Unique webhook identifier. */
  id: number;
  /** The delivery URL. */
  url: string;
  /** The subscribed event type ("*" for all). */
  eventType: string;
  /**
   * Signing secret for verifying delivered event signatures. Returned only at
   * creation time — store it now; it cannot be retrieved later.
   */
  secret: string;
}

// ===========================================================================
// Internal response shapes + mappers
//
// Each map* helper builds a clean public object field-by-field (never a
// passthrough spread), so the exported types are the single source of truth for
// what a caller receives.
// ===========================================================================

interface RawInbox {
  inboxId: string;
  email: string;
  displayName?: string;
  clientId?: string;
  createdAt: string;
  updatedAt: string;
}

interface RawInboxList {
  count: number;
  nextPageToken?: string;
  inboxes: RawInbox[];
}

interface RawAttachment {
  attachmentId: string;
  filename?: string;
  contentType?: string;
  size: number;
}

interface RawMessage {
  messageId: string;
  threadId: string;
  inboxId: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject?: string;
  preview?: string;
  text?: string;
  html?: string;
  extractedText?: string;
  extractedHtml?: string;
  labels: string[];
  timestamp: string;
  inReplyTo?: string;
  references?: string[];
  headers?: Record<string, string>;
  attachments?: RawAttachment[];
  size: number;
  createdAt: string;
  updatedAt: string;
}

interface RawMessageList {
  count: number;
  nextPageToken?: string;
  messages: RawMessage[];
}

interface RawSendResult {
  messageId: string;
  threadId: string;
}

interface RawThread {
  threadId: string;
  inboxId: string;
  labels: string[];
  timestamp: string;
  receivedTimestamp?: string;
  sentTimestamp?: string;
  subject?: string;
  preview?: string;
  senders: string[];
  recipients: string[];
  lastMessageId: string;
  messageCount: number;
  size: number;
  attachments?: RawAttachment[];
  createdAt: string;
  updatedAt: string;
  messages: RawMessage[];
}

interface RawThreadList {
  count: number;
  nextPageToken?: string;
  threads: Omit<RawThread, "messages">[];
}

interface RawDomainRecord {
  type: "TXT" | "CNAME" | "MX";
  name: string;
  value: string;
  status: "MISSING" | "INVALID" | "VALID";
  priority?: number;
}

interface RawDomain {
  domainId: string;
  domain: string;
  status: DomainStatus;
  feedbackEnabled: boolean;
  records: RawDomainRecord[];
  createdAt: string;
  updatedAt: string;
}

interface RawDomainListItem {
  domainId: string;
  domain: string;
  feedbackEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RawDomainList {
  count: number;
  domains: RawDomainListItem[];
}

interface RawWebhook {
  id: number;
  url: string;
  eventType: string;
  secret: string;
}

function mapInbox(raw: RawInbox): Inbox {
  return {
    inboxId: raw.inboxId,
    email: raw.email,
    ...(raw.displayName !== undefined && { displayName: raw.displayName }),
    ...(raw.clientId !== undefined && { clientId: raw.clientId }),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function mapAttachment(raw: RawAttachment): Attachment {
  return {
    attachmentId: raw.attachmentId,
    ...(raw.filename !== undefined && { filename: raw.filename }),
    ...(raw.contentType !== undefined && { contentType: raw.contentType }),
    size: raw.size,
  };
}

function mapMessage(raw: RawMessage): Message {
  return {
    messageId: raw.messageId,
    threadId: raw.threadId,
    inboxId: raw.inboxId,
    from: raw.from,
    to: raw.to,
    ...(raw.cc !== undefined && { cc: raw.cc }),
    ...(raw.bcc !== undefined && { bcc: raw.bcc }),
    ...(raw.replyTo !== undefined && { replyTo: raw.replyTo }),
    ...(raw.subject !== undefined && { subject: raw.subject }),
    ...(raw.preview !== undefined && { preview: raw.preview }),
    ...(raw.text !== undefined && { text: raw.text }),
    ...(raw.html !== undefined && { html: raw.html }),
    ...(raw.extractedText !== undefined && {
      extractedText: raw.extractedText,
    }),
    ...(raw.extractedHtml !== undefined && {
      extractedHtml: raw.extractedHtml,
    }),
    labels: raw.labels,
    timestamp: raw.timestamp,
    ...(raw.inReplyTo !== undefined && { inReplyTo: raw.inReplyTo }),
    ...(raw.references !== undefined && { references: raw.references }),
    ...(raw.headers !== undefined && { headers: raw.headers }),
    ...(raw.attachments !== undefined && {
      attachments: raw.attachments.map(mapAttachment),
    }),
    size: raw.size,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function mapMessageListItem(raw: RawMessage): MessageListItem {
  const { text, html, extractedText, extractedHtml, replyTo, ...rest } =
    mapMessage(raw);
  // Reference the destructured body fields so the omit is intentional, not a lint error.
  void text;
  void html;
  void extractedText;
  void extractedHtml;
  void replyTo;
  return rest;
}

function mapThreadListItem(raw: Omit<RawThread, "messages">): ThreadListItem {
  return {
    threadId: raw.threadId,
    inboxId: raw.inboxId,
    labels: raw.labels,
    timestamp: raw.timestamp,
    ...(raw.receivedTimestamp !== undefined && {
      receivedTimestamp: raw.receivedTimestamp,
    }),
    ...(raw.sentTimestamp !== undefined && {
      sentTimestamp: raw.sentTimestamp,
    }),
    ...(raw.subject !== undefined && { subject: raw.subject }),
    ...(raw.preview !== undefined && { preview: raw.preview }),
    senders: raw.senders,
    recipients: raw.recipients,
    lastMessageId: raw.lastMessageId,
    messageCount: raw.messageCount,
    size: raw.size,
    ...(raw.attachments !== undefined && {
      attachments: raw.attachments.map(mapAttachment),
    }),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function mapThread(raw: RawThread): Thread {
  return {
    ...mapThreadListItem(raw),
    messages: raw.messages.map(mapMessage),
  };
}

function mapDomainRecord(raw: RawDomainRecord): DomainRecord {
  return {
    type: raw.type,
    name: raw.name,
    value: raw.value,
    status: raw.status,
    ...(raw.priority !== undefined && { priority: raw.priority }),
  };
}

function mapDomain(raw: RawDomain): Domain {
  return {
    domainId: raw.domainId,
    domain: raw.domain,
    status: raw.status,
    feedbackEnabled: raw.feedbackEnabled,
    records: raw.records.map(mapDomainRecord),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function mapDomainListItem(raw: RawDomainListItem): DomainListItem {
  return {
    domainId: raw.domainId,
    domain: raw.domain,
    feedbackEnabled: raw.feedbackEnabled,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function mapWebhook(raw: RawWebhook): Webhook {
  return {
    id: raw.id,
    url: raw.url,
    eventType: raw.eventType,
    secret: raw.secret,
  };
}

// ===========================================================================
// Guards & request shaping
// ===========================================================================

/**
 * Guard a required id (inbox / message / thread / domain) client-side, so a JS
 * caller passing null / undefined / "" gets a clear error instead of a confusing
 * request to a malformed path.
 */
function assertId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EmailHttpError(
      `${label} is required and must be a non-empty string`,
      400,
      undefined,
    );
  }
  return value;
}

/**
 * Percent-encode a path segment while preserving the address form of an inbox id
 * (which contains `@` and may contain `.`): encode the whole segment. An inbox id
 * is a single segment, so a plain `encodeURIComponent` is correct.
 */
function encodeSegment(id: string): string {
  return encodeURIComponent(id);
}

/** Append `limit` / `pageToken` to a URL when present (each a truthy check → null/undefined dropped). */
function appendPageParams(
  url: URL,
  opts?: { limit?: number; pageToken?: string },
): void {
  if (opts?.limit != null) url.searchParams.set("limit", String(opts.limit));
  if (opts?.pageToken != null && opts.pageToken !== "") {
    url.searchParams.set("pageToken", opts.pageToken);
  }
}

/** Copy a value onto `body` only when it is neither undefined nor null. */
function set(body: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) body[key] = value;
}

function sendBody(input: SendMessageInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  set(body, "to", input.to);
  set(body, "cc", input.cc);
  set(body, "bcc", input.bcc);
  set(body, "replyTo", input.replyTo);
  set(body, "subject", input.subject);
  set(body, "text", input.text);
  set(body, "html", input.html);
  set(body, "headers", input.headers);
  set(body, "labels", input.labels);
  return body;
}

function replyBody(input: ReplyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  set(body, "to", input.to);
  set(body, "cc", input.cc);
  set(body, "bcc", input.bcc);
  set(body, "replyTo", input.replyTo);
  set(body, "replyAll", input.replyAll);
  set(body, "text", input.text);
  set(body, "html", input.html);
  set(body, "headers", input.headers);
  set(body, "labels", input.labels);
  return body;
}

function replyAllBody(input: ReplyAllInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  set(body, "replyTo", input.replyTo);
  set(body, "text", input.text);
  set(body, "html", input.html);
  set(body, "headers", input.headers);
  set(body, "labels", input.labels);
  return body;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

// ===========================================================================
// Inboxes — operations
// ===========================================================================

/** Create a new inbox (a real, addressable mailbox). */
export async function createInbox(
  input: CreateInboxInput = {},
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Inbox> {
  const body: Record<string, unknown> = {};
  set(body, "username", input.username);
  set(body, "domain", input.domain);
  set(body, "displayName", input.displayName);
  set(body, "clientId", input.clientId);

  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/inboxes`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    }),
    "Failed to create inbox",
  );
  return mapInbox((await res.json()) as RawInbox);
}

/** List the caller's inboxes. */
export async function listInboxes(
  opts?: ListInboxesOptions,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<InboxList> {
  const url = new URL(`${baseUrl}/v1/inboxes`);
  appendPageParams(url, opts);
  const res = await ensureOk(
    await transport.fetch(url.toString()),
    "Failed to list inboxes",
  );
  const raw = (await res.json()) as RawInboxList;
  return {
    count: raw.count,
    ...(raw.nextPageToken !== undefined && {
      nextPageToken: raw.nextPageToken,
    }),
    inboxes: raw.inboxes.map(mapInbox),
  };
}

/** Fetch a single inbox by id (the inbox's email address). */
export async function getInbox(
  inboxId: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Inbox> {
  const id = assertId(inboxId, "inboxId");
  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/inboxes/${encodeSegment(id)}`),
    `Failed to get inbox '${id}'`,
  );
  return mapInbox((await res.json()) as RawInbox);
}

/** Delete an inbox by id. */
async function deleteInbox(
  inboxId: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<void> {
  const id = assertId(inboxId, "inboxId");
  await ensureOk(
    await transport.fetch(`${baseUrl}/v1/inboxes/${encodeSegment(id)}`, {
      method: "DELETE",
    }),
    `Failed to delete inbox '${id}'`,
  );
}

export { deleteInbox };

// ===========================================================================
// Messages — operations
// ===========================================================================

/** Send a new message from an inbox. */
export async function sendMessage(
  inboxId: string,
  input: SendMessageInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<SendResult> {
  const id = assertId(inboxId, "inboxId");
  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/inboxes/${encodeSegment(id)}/messages`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(sendBody(input)),
      },
    ),
    `Failed to send message from inbox '${id}'`,
  );
  const raw = (await res.json()) as RawSendResult;
  return { messageId: raw.messageId, threadId: raw.threadId };
}

/** List messages in an inbox (metadata only — use `get` for the body). */
export async function listMessages(
  inboxId: string,
  opts?: ListMessagesOptions,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<MessageList> {
  const id = assertId(inboxId, "inboxId");
  const url = new URL(`${baseUrl}/v1/inboxes/${encodeSegment(id)}/messages`);
  appendPageParams(url, opts);
  const res = await ensureOk(
    await transport.fetch(url.toString()),
    `Failed to list messages in inbox '${id}'`,
  );
  const raw = (await res.json()) as RawMessageList;
  return {
    count: raw.count,
    ...(raw.nextPageToken !== undefined && {
      nextPageToken: raw.nextPageToken,
    }),
    messages: raw.messages.map(mapMessageListItem),
  };
}

/** Fetch a single full message (including body) by id. */
export async function getMessage(
  inboxId: string,
  messageId: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Message> {
  const inbox = assertId(inboxId, "inboxId");
  const message = assertId(messageId, "messageId");
  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/inboxes/${encodeSegment(inbox)}/messages/${encodeSegment(message)}`,
    ),
    `Failed to get message '${message}'`,
  );
  return mapMessage((await res.json()) as RawMessage);
}

/** Reply to a message. */
export async function replyMessage(
  inboxId: string,
  messageId: string,
  input: ReplyInput = {},
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<SendResult> {
  const inbox = assertId(inboxId, "inboxId");
  const message = assertId(messageId, "messageId");
  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/inboxes/${encodeSegment(inbox)}/messages/${encodeSegment(message)}/reply`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(replyBody(input)),
      },
    ),
    `Failed to reply to message '${message}'`,
  );
  const raw = (await res.json()) as RawSendResult;
  return { messageId: raw.messageId, threadId: raw.threadId };
}

/** Reply to everyone on a message. */
export async function replyAllMessage(
  inboxId: string,
  messageId: string,
  input: ReplyAllInput = {},
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<SendResult> {
  const inbox = assertId(inboxId, "inboxId");
  const message = assertId(messageId, "messageId");
  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/inboxes/${encodeSegment(inbox)}/messages/${encodeSegment(message)}/reply-all`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(replyAllBody(input)),
      },
    ),
    `Failed to reply-all to message '${message}'`,
  );
  const raw = (await res.json()) as RawSendResult;
  return { messageId: raw.messageId, threadId: raw.threadId };
}

/** Forward a message to new recipient(s). */
export async function forwardMessage(
  inboxId: string,
  messageId: string,
  input: SendMessageInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<SendResult> {
  const inbox = assertId(inboxId, "inboxId");
  const message = assertId(messageId, "messageId");
  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/inboxes/${encodeSegment(inbox)}/messages/${encodeSegment(message)}/forward`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(sendBody(input)),
      },
    ),
    `Failed to forward message '${message}'`,
  );
  const raw = (await res.json()) as RawSendResult;
  return { messageId: raw.messageId, threadId: raw.threadId };
}

// ===========================================================================
// Threads — operations
// ===========================================================================

/** List conversation threads in an inbox (without their messages). */
export async function listThreads(
  inboxId: string,
  opts?: ListThreadsOptions,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<ThreadList> {
  const id = assertId(inboxId, "inboxId");
  const url = new URL(`${baseUrl}/v1/inboxes/${encodeSegment(id)}/threads`);
  appendPageParams(url, opts);
  const res = await ensureOk(
    await transport.fetch(url.toString()),
    `Failed to list threads in inbox '${id}'`,
  );
  const raw = (await res.json()) as RawThreadList;
  return {
    count: raw.count,
    ...(raw.nextPageToken !== undefined && {
      nextPageToken: raw.nextPageToken,
    }),
    threads: raw.threads.map(mapThreadListItem),
  };
}

/** Fetch a single full thread (including its messages) by id. */
export async function getThread(
  inboxId: string,
  threadId: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Thread> {
  const inbox = assertId(inboxId, "inboxId");
  const thread = assertId(threadId, "threadId");
  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/inboxes/${encodeSegment(inbox)}/threads/${encodeSegment(thread)}`,
    ),
    `Failed to get thread '${thread}'`,
  );
  return mapThread((await res.json()) as RawThread);
}

// ===========================================================================
// Domains — operations
// ===========================================================================

/** Register a custom sending domain. Returns the DNS records to publish. */
export async function createDomain(
  input: CreateDomainInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Domain> {
  const domain = assertId(input?.domain, "domain");
  const body: Record<string, unknown> = { domain };
  set(body, "feedbackEnabled", input.feedbackEnabled);
  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/domains`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    }),
    `Failed to create domain '${domain}'`,
  );
  return mapDomain((await res.json()) as RawDomain);
}

/**
 * Trigger DNS re-verification for a domain. Returns nothing — re-fetch the domain
 * with `domains.get` to read the updated status and records.
 */
export async function verifyDomain(
  domainId: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<void> {
  const id = assertId(domainId, "domainId");
  await ensureOk(
    await transport.fetch(`${baseUrl}/v1/domains/${encodeSegment(id)}/verify`, {
      method: "POST",
    }),
    `Failed to verify domain '${id}'`,
  );
}

/** Fetch a domain's full status and DNS records by id. */
export async function getDomain(
  domainId: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Domain> {
  const id = assertId(domainId, "domainId");
  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/domains/${encodeSegment(id)}`),
    `Failed to get domain '${id}'`,
  );
  return mapDomain((await res.json()) as RawDomain);
}

/** List registered domains (without per-domain status/records). */
export async function listDomains(
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<DomainList> {
  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/domains`),
    "Failed to list domains",
  );
  const raw = (await res.json()) as RawDomainList;
  return { count: raw.count, domains: raw.domains.map(mapDomainListItem) };
}

/** Delete a registered domain by id. */
async function deleteDomain(
  domainId: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<void> {
  const id = assertId(domainId, "domainId");
  await ensureOk(
    await transport.fetch(`${baseUrl}/v1/domains/${encodeSegment(id)}`, {
      method: "DELETE",
    }),
    `Failed to delete domain '${id}'`,
  );
}

export { deleteDomain };

// ===========================================================================
// Webhooks — operations
// ===========================================================================

/**
 * Register a webhook for inbound events. The returned `secret` is shown only once —
 * store it to verify delivered event signatures.
 */
export async function createWebhook(
  input: CreateWebhookInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Webhook> {
  const url = assertId(input?.url, "url");
  const eventType = assertId(input?.eventType, "eventType");
  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/webhooks`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ url, eventType }),
    }),
    "Failed to create webhook",
  );
  return mapWebhook((await res.json()) as RawWebhook);
}

/** Delete a webhook by id. */
async function deleteWebhook(
  id: number,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<void> {
  if (typeof id !== "number" || !Number.isFinite(id)) {
    throw new EmailHttpError(
      "webhook id is required and must be a number",
      400,
      undefined,
    );
  }
  await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/webhooks/${encodeURIComponent(String(id))}`,
      { method: "DELETE" },
    ),
    `Failed to delete webhook '${id}'`,
  );
}

export { deleteWebhook };
