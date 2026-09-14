# @sapiom/opencode

Pinned OpenCode 1.18.29 and its matching plugin dependencies are installed with
the package. Each native launch links that installed plugin into its private
configuration, so opening another Assistant session does not run an npm install
or wait for the package registry. Studio owns authorization, working directory,
state directory, credentials, and shutdown. OpenCode owns conversations and agent
execution.

```ts
const config = createSapiomOpenCodeConfig({ bridgeUrl, runtimeToken });
const server = await startOpenCodeServer({ cwd, stateRoot, config, signal });
// Only call this after Studio has authorized the selected workspace and user.
await server.close();
```

The bridge URL must be loopback. Only its revocable credential enters the model
and remote MCP configuration. The runtime inherits an allowlist of platform
environment variables; provider keys and the Electron esbuild pin are excluded
from the runtime. A controlled native plugin removes the bridge configuration
and runtime-admin credential from the runtime environment before tool execution,
and startup fails if that plugin does not initialize or if native HTTP
authentication stops rejecting unauthenticated requests. OpenCode project
configuration, global configuration, default plugins, Claude configuration, and
external skills are excluded; the sole configured plugin is created in an
ephemeral config root. The native process also receives an ephemeral home so
OpenCode cannot discover `$HOME/.opencode`; the controlled shell hook restores
the caller's original home variables for user tools and resolves an absent
`HOME` from `USERPROFILE`, `HOMEDRIVE`/`HOMEPATH`, or the OS account instead of
exposing the native isolation directory. Runtime state stays below the supplied
directory.

The runtime credential has no independent time-to-live. Its lifetime is bounded
by the Studio grant: grant expiry, access revocation, or runtime retirement
revokes it at the bridge, and a replacement runtime receives a rotated
credential. This protects normal child-process and browser boundaries; it is not
an operating-system sandbox. An unrestricted process running as the same user
can inspect runtime memory or files and is outside this trust boundary.

Startup and shutdown have deadlines. Studio can durably protect the generated
supervisor through `beforeLaunch`; native work starts only after that callback
resolves. POSIX cleanup first stops the native launcher, then stops and removes
its birth-validated native-managed descendants before publishing a run-scoped
cleanup proof. A missing proof fails closed so another runtime cannot write the
same state. The proof remains outside the ephemeral launch directory until the
runtime lock consumes it. Windows uses its native process-tree termination for
normal close; installed-platform validation remains tracked by SAP-3297.
Linux process scans tolerate entries that disappear during the read; unreadable
entries still fail cleanup, and a missing tracked process cannot prove it stopped.
Binary paths inside `app.asar` resolve to their unpacked counterparts; the
generated supervisor needs no source loader and runs under Electron with
`ELECTRON_RUN_AS_NODE` without forwarding that variable to native or tools.

`pnpm` must allow the `opencode-ai` install script so the platform binary exists
before Studio starts. The workspace allowlist includes it. No UI is bundled in
this package.

## Accepted Studio context

The exported context contract validates host-owned accepted records before storage
or native prompt composition. Source hashes cover exact bytes (including CRLF),
while descriptor revisions cover identity, provenance, applicability and content.
An instruction set retains explicit scope, skill and MCP manifests even when empty.
Its accepted reference binds the immutable facts and instruction set to one native
conversation and a stable, secret-free host authority scope. It is not an access grant.

Required sources must be available; an optional source's recorded absence is explicit.
Validation rejects unknown fields, foreign references and inconsistent revisions.
The 4 MiB serialized-record, 4,096-entry and 24-level limits reject oversized data;
they never truncate required guidance. This contract does not enable context delivery,
source fetching or caching on its own.

Saved accepted prompts retain the leading `StudioAssistantResult/v2:<attempt>`
completion contract and append one canonical `StudioAssistantContext/v2` envelope.
The envelope carries verified inline text, catalog manifests and package references.
Native validation recomputes inline hashes and record revisions; the host separately
verifies retained package bytes before dispatch. Native projection places stable
guidance before the real completion contract and JSON-escaped dynamic facts, without
rewriting saved history. Legacy completion-only and valid inline context/v1 records
have explicit parser variants; malformed claimed context never becomes generic.

`createStudioAssistantContextHooks(loadSessionMessages, authorityScope)` provides the
native consumer. It requires the owned runtime's actual system-hook `messageID` and
executing `agent` fields for claimed Studio requests. Ordinary requests require their
exact message capture; titles can verify their historical user through native history.
Compaction history copies cannot replace another request's capture. Synthetic users
restore the original saved contract before capture, including later tool-loop steps.

Projection replaces only the exact terminal saved system, preserves native prefix
bytes and mutates the existing system array. Per-request validation failures stay
sticky through the active native execution and are thrown at the provider boundary using the fixed
message `Studio assistant context could not be verified`. Native serializes it as an
`UnknownError` without triggering overload retries. Calling without an authority scope
retains completion-only behavior. Scoped ordinary and synthetic requests require
accepted context/v2 or valid inline context/v1; unclaimed helpers remain unchanged.
Studio host activation and the corrected artifact are separate stack prerequisites.

The managed launcher installs this consumer through its existing credential-isolation
plugin when given `assistantContext: { authorityScope }`. The generated plugin uses
the compiled hook, including the desktop unpacked path, and still awaits native
plugin readiness. Omitting the option preserves completion-only launches. Studio
host activation depends on the corrected runtime artifact.

`SAPIOM_OPENCODE_CONTEXT_TEST_BINARY=/absolute/path/to/corrected/opencode pnpm test`
runs the actual consumer test through the generated plugin and a controlled local
model endpoint. It covers tools, titles, compaction/continuation, recovery, legacy
inline context, isolated sessions, and malformed required context. Native errors
are checked for a fixed message without stack paths or provider retries; Studio
maps only that exact error shape inside the authorized conversation event scope.
The full saved-text cache is bounded independently of successful capture proofs.
Pending ordinary requests and native retries can reload evicted captures only
when the saved bytes match their original fingerprint. Changing a saved user ID's
context fails closed during that execution. Native idle/deletion retires its capture
and proof epoch, so saved history does not accumulate in process memory. Historical
titles still verify their exact saved user. Deletion guards live only while a system
callback is in flight and reject callbacks that race deletion. Ordinary callbacks
from a retired execution require a new native messages capture.
