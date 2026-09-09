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
from tool processes. Project/global Claude configuration and external skills are
disabled. Runtime state stays below the supplied directory.

Startup and shutdown have deadlines. POSIX shutdown signals the owned process
group; Windows process-tree hardening and packaged-platform validation remain
tracked by SAP-3297. Binary paths inside `app.asar` resolve to their unpacked
counterparts; the desktop packager must include the native binary there.

`pnpm` must allow the `opencode-ai` install script so the platform binary exists
before Studio starts. The workspace allowlist includes it. No UI is bundled in
this package.
