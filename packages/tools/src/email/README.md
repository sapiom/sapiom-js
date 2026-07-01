# email

Programmatic transactional email. Create real, addressable inboxes, send and
receive messages, manage custom sending domains, read conversation threads, and
register webhooks for inbound events. The same email capability your agents call
over MCP, callable directly from your code.

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

// Create an inbox, then send from it.
const inbox = await sapiom.email.inboxes.create({ username: "support" });
await sapiom.email.messages.send(inbox.inboxId, {
  to: "customer@example.com",
  subject: "Welcome",
  text: "Thanks for signing up!",
});

// Read what came in, and reply to it.
const { messages } = await sapiom.email.messages.list(inbox.inboxId);
const full = await sapiom.email.messages.get(
  inbox.inboxId,
  messages[0].messageId,
);
await sapiom.email.messages.reply(inbox.inboxId, full.messageId, {
  text: "Happy to help!",
});
```

Ambient import works too: `import { email } from "@sapiom/tools"`.

## Operations

Operations are grouped by resource:

- **`inboxes`** — `create`, `list`, `get`, `delete`
- **`messages`** — `send`, `list`, `get`, `reply`, `replyAll`, `forward`
- **`domains`** — `create`, `verify`, `get`, `list`, `delete`
- **`threads`** — `list`, `get`
- **`webhooks`** — `create`, `delete`

## Inboxes

An inbox is a real mailbox you own. Its `inboxId` **is its email address** — use it
directly as the recipient of inbound mail and as the first argument to every message
and thread call. `create` accepts an optional `username`, `displayName`, and a
verified custom `domain` (see below); omit them and you get a generated address on
the default domain.

## Messages

- `send` requires `to` (a single address or an array) and takes `cc` / `bcc` /
  `replyTo`, `subject`, `text` and/or `html`, `labels`, and custom `headers`.
- `list` returns **metadata only** — no body. Call `get` for the full message,
  which additionally includes `text` / `html` and `extractedText` / `extractedHtml`
  (the "new" content with quoted reply history stripped — what you usually want when
  processing a reply).
- `reply`, `replyAll`, and `forward` all return `{ messageId, threadId }`.
- Custom `headers` may not set address, identity, routing, or MIME headers (e.g.
  `To`, `From`, `Reply-To`, `Subject`, `Content-Type`) — use the dedicated fields
  for those; such headers are rejected.

## Domains

To send from your own domain, register it with `domains.create({ domain })`. The
response includes the DNS `records` you must publish. Once published, call
`domains.verify(domainId)`, then re-fetch with `domains.get(domainId)` to read the
updated `status` (`PENDING` → `VERIFIED`). `domains.list` returns domains without
their `status`/`records`; use `get` for the full detail.

## Threads

A thread groups the messages of a conversation. `threads.list` returns thread
summaries (without messages); `threads.get` returns the full thread including its
`messages` array.

## Webhooks

`webhooks.create({ url, eventType })` registers an HTTPS endpoint to receive inbound
events (e.g. `"message.received"`, or `"*"` for all). The response includes a
`secret` **returned only once** — store it to verify the signature on delivered
events.

## Gotchas

- **`inboxId` is the email address.** It contains `@` (and often `.`); pass it
  as-is — the client handles URL encoding.
- **`list` is metadata-only.** `messages.list` and `threads.list` omit bodies /
  messages; fetch the individual resource with `get` to read content.
- **The webhook `secret` is shown once.** It is present only on the `create`
  response; capture it then.
- **Pagination** is cursor-based: pass the previous response's `nextPageToken` back
  as `pageToken`.
- **Failed requests throw `EmailHttpError`** (carries `status` + parsed `body`),
  exported from `@sapiom/tools`.
