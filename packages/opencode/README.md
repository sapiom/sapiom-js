# @sapiom/opencode

Pinned OpenCode 1.18.29, started directly through `startOpenCodeServer()` without
an installation command at runtime. Studio owns authorization, working directory,
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
ephemeral config root. Runtime state stays below the supplied directory.

The runtime credential has no independent time-to-live. Its lifetime is bounded
by the Studio grant: grant expiry, access revocation, or runtime retirement
revokes it at the bridge, and a replacement runtime receives a rotated
credential. This protects normal child-process and browser boundaries; it is not
an operating-system sandbox. An unrestricted process running as the same user
can inspect runtime memory or files and is outside this trust boundary.

Startup and shutdown have deadlines. POSIX shutdown signals the owned process
group; Windows process-tree hardening and packaged-platform validation remain
tracked by SAP-3297. Binary paths inside `app.asar` resolve to their unpacked
counterparts; the desktop packager must include the native binary there.

`pnpm` must allow the `opencode-ai` install script so the platform binary exists
before Studio starts. The workspace allowlist includes it. No UI is bundled in
this package.
