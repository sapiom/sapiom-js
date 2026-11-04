# slack

Post, edit, and react to Slack messages and read channels, threads and users over a tenant's
connected Slack workspace. The gateway resolves the bot token server-side; it never
reaches your run. An unconnected tenant gets a `404 connector_not_found`.

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

const { ts } = await sapiom.connectors.slack.postMessage({
  channel: "C0123456789",
  text: "Looking into it.",
});
await sapiom.connectors.slack.addReaction({
  channel: "C0123456789",
  timestamp: ts!,
  name: "eyes",
});
```

Ambient import works too: `import { connectors } from "@sapiom/tools"` (then `connectors.slack`).

## Operations

| SDK method             | Slack method            | Args                                                                       |
| ---------------------- | ----------------------- | -------------------------------------------------------------------------- |
| `postMessage(args)`    | `chat.postMessage`      | `channel`, `text?`, `blocks?`, `threadTs?`                                 |
| `update(args)`         | `chat.update`           | `channel`, `ts`, `text?`, `blocks?`                                        |
| `postEphemeral(args)`  | `chat.postEphemeral`    | `channel`, `user`, `text?`, `blocks?`, `threadTs?`                         |
| `addReaction(args)`    | `reactions.add`         | `channel`, `timestamp`, `name`                                             |
| `removeReaction(args)` | `reactions.remove`      | `channel`, `timestamp`, `name`                                             |
| `replies(args)`        | `conversations.replies` | `channel`, `ts`, `cursor?`, `limit?`                                       |
| `history(args)`        | `conversations.history` | `channel`, `cursor?`, `limit?`, `oldest?`, `latest?`, `inclusive?`         |
| `whoAmI()`             | `auth.test`             | none                                                                       |
| `userInfo(args)`       | `users.info`            | `user`                                                                     |
| `downloadFile(args)`   | `files.download`        | `file`                                                                     |
| `uploadFile(args)`     | `files.upload`          | `fileId`, `channel`, `threadTs?`, `title?`, `initialComment?`, `fileName?` |

Message methods need `text`, `blocks`, or both. `postMessage` resolves to
`{ ok, channel, ts }`; the others resolve to Slack's own response body. Slack answering
`ok: false` surfaces as a `502` whose message names Slack's error code
(e.g. `channel_not_found`, `not_in_channel`).

`history` returns a channel's top-level messages, newest first; read a thread's replies
with `replies`. It needs the bot to be in the channel: Slack answers `not_in_channel`
otherwise, so invite the Sapiom app first. `whoAmI` returns the bot's `user_id` and
`bot_id`, the `user` / `bot_id` on messages it posted, so an agent can pick out its own
posts from `history`.

## Files

`downloadFile` and `uploadFile` move bytes through the tenant's file storage
(`fileStorage`), so a run handles a `fileId`, never base64 or Slack's private URLs.
They are Sapiom methods: `files.download` and `files.upload` exist only on the gateway's
method route.

```typescript
// A `slack.message.created` event with subtype `file_share` carries `files[]`.
const photo = await sapiom.connectors.slack.downloadFile({
  file: event.files[0].id,
});
// photo: { fileId, contentType, fileName, size }
const { downloadUrl } = await sapiom.fileStorage.getDownloadUrl(photo.fileId);

// Post a rendered image back as a thread reply: store it, then share it.
const { fileId, uploadUrl, requiredHeaders } = await sapiom.fileStorage.upload({
  contentType: "image/png",
  fileName: "board.png",
  fileSize: png.byteLength,
});
await fetch(uploadUrl, { method: "PUT", headers: requiredHeaders, body: png });
await sapiom.connectors.slack.uploadFile({
  fileId,
  channel: event.channel,
  threadTs: event.ts,
  initialComment: "Black wins by 3.5.",
});
```

- Both cap a file at 25 MiB.
- `downloadFile` stores a private file in the tenant's storage, billed as any stored file.
- `uploadFile` takes only a `fileId` the tenant owns; another tenant's file, even a public
  one, is refused with a `400`. It can be called right after the `PUT`: the gateway
  checks a still-pending upload itself. If the bytes have not landed it answers a `400`
  that says to retry.
- `downloadFile` needs the `files:read` scope and `uploadFile` needs `files:write`. A
  Slack connection made before they were added answers `403 oauth_scope_not_granted`
  naming the scope: reconnect Slack to grant it.
- `uploadFile` needs the bot in the channel; Slack answers `not_in_channel` otherwise.
