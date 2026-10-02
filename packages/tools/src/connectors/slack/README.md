# slack

Post, edit, and react to Slack messages and read threads and users over a tenant's
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

| SDK method             | Slack method            | Args                                               |
| ---------------------- | ----------------------- | -------------------------------------------------- |
| `postMessage(args)`    | `chat.postMessage`      | `channel`, `text?`, `blocks?`, `threadTs?`         |
| `update(args)`         | `chat.update`           | `channel`, `ts`, `text?`, `blocks?`                |
| `postEphemeral(args)`  | `chat.postEphemeral`    | `channel`, `user`, `text?`, `blocks?`, `threadTs?` |
| `addReaction(args)`    | `reactions.add`         | `channel`, `timestamp`, `name`                     |
| `removeReaction(args)` | `reactions.remove`      | `channel`, `timestamp`, `name`                     |
| `replies(args)`        | `conversations.replies` | `channel`, `ts`, `cursor?`, `limit?`               |
| `userInfo(args)`       | `users.info`            | `user`                                             |

Message methods need `text`, `blocks`, or both. `postMessage` resolves to
`{ ok, channel, ts }`; the others resolve to Slack's own response body. Slack answering
`ok: false` surfaces as a `502` whose message names Slack's error code
(e.g. `channel_not_found`, `not_in_channel`).
