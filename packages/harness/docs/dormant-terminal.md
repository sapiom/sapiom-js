# Starting Terminal in a dormant session

Recorded Continue allocates a Studio row with `terminalState: "not-started"`.
Its Assistant conversation can be prepared without launching a Terminal process.

`POST /api/sessions/:id/terminal/start` with the boot token and an empty JSON
object explicitly starts the first Terminal in that same Studio session. The
server revalidates workspace/project authority and prepares current credentials.
It runs the normal adapter launch without an initial prompt, parent context, or
automatic project bootstrap. No workspace or launch overrides are accepted.

Concurrent starts share one preparation. End cancels older preparation before
spawn; a failure before spawn keeps the not-started marker. The marker is removed
only when the first PTY is published. Assistant association remains unchanged.
Repeated calls while that allocated Terminal is live return it; after it exits,
use the ordinary Terminal Resume flow. Conflicts return 409, unknown IDs 404.
