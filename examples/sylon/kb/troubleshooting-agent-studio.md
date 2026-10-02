# Troubleshoot Agent Studio

Source: https://docs.sapiom.ai/troubleshooting/agent-studio

## Command-line launch

### Node or a coding agent is missing

The `npx` host exits when Node is older than 20 or no supported coding-agent executable is available. Install or update Node first, then install Claude Code or Codex:

```bash
npm i -g @anthropic-ai/claude-code
```

```bash
npm i -g @openai/codex
```

Open a new terminal and verify Node plus at least one coding-agent command before retrying Studio:

```bash
node --version
claude --version
codex --version
```

If the selected command works in one shell but Studio reports “not found on PATH,” launch `npx` from that same shell and inspect the shell's `PATH`. A desktop app does not inherit every interactive-shell customization; when neither client is available, its first-launch setup tries a per-user Claude Code installation and re-runs the environment check.

### Port 4100 is already in use

Choose another numeric port:

```bash
npx @sapiom/agent-studio@latest --port 4200
```

The browser URL and boot token are specific to that launch. Do not reuse a URL printed by an earlier Studio process.

### The browser did not open

An operating-system browser-opener failure no longer terminates an otherwise healthy Studio server. Read the startup banner and open the complete URL it printed on the same machine. It has this shape:

```text
http://localhost:4100/?token=<per-boot-token>
```

Copy the whole URL. Opening bare `http://localhost:4100` omits the token and returns an unauthorized response. To make the manual flow intentional on the next launch, add `--no-open`.

### Studio exits with a server-start error

Read the final error after the doctor and consent output. Common causes are a port collision, an unreadable launch directory, or an unwritable state root. Retry with one known existing project directory and, when isolating state, one writable scratch directory:

```bash
npx @sapiom/agent-studio@latest /absolute/path/to/project --state-root /absolute/path/to/scratch-state --no-telemetry --no-open
```

`--dev` is a repository diagnostic that tolerates server-start failure after checking the pre-server flow; it is not a remedy for normal product use.

## Desktop first launch

The desktop host supplies its own Node/npm runtime. It accepts an installed Claude Code or Codex executable. When neither is found, it installs Claude Code into the app's per-user npm prefix, checks again, and falls back to a retryable setup screen.

If automatic setup reports an npm failure:

1. Keep the setup window open and read its final error detail.
2. Confirm the machine has network access to npm.
3. If needed, install Claude Code manually with `npm i -g @anthropic-ai/claude-code` in a terminal.
4. Choose **Retry** in the setup window so the desktop host re-runs its environment check.
   On macOS, if the operating system blocks the app itself, open **System Settings → Privacy & Security**, inspect the named Sapiom app warning, and allow the app only if it is the release you intended to install. Current release signing and platform availability are recorded on [Install Agent Studio](/agent-studio/install).

## A session is running but not ready

**Running** means the terminal process exists. **Ready** means Studio has observed a coding-agent state where programmatic input is safe. A new session can stay running but not ready while the visible terminal is asking you to:

- trust the working directory;
- authenticate the coding agent;
- complete its first-run flow; or
- dismiss another blocking prompt.

Answer the prompt in the terminal. Studio actions that type into the coding agent remain disabled until readiness is detected; direct **Local Run**, **Deploy**, and **Prod Run** do not depend on coding-agent readiness. All require Studio's Sapiom authentication, while the two cloud actions have additional deployment and hosted-state gates.

## Sapiom sign-in

### Studio is waiting for Sapiom sign-in

Use **Connect account** and complete browser sign-in before using Studio or starting an MCP-backed coding-agent session. A cached credential is reused automatically; `--login` only opens browser sign-in when the cache is absent. Signed-out agent authoring is not a supported state.

If browser sign-in does not finish, return to Studio and retry **Connect account**. Do not substitute the local boot token for a Sapiom API key. The local token protects one loopback Studio process; the cached Sapiom credential authorizes Studio, Sapiom MCP, and organization-owned cloud actions.

### “Unauthorized” on Deploy or Prod Run

Connect the Sapiom account and retry the action. If Studio still shows the wrong account, choose **Disconnect**, connect again, and confirm the organization name in the menu. Local Run still requires that Studio authentication, although its step execution and capability stubs stay local.

See [Configure authentication and runtime inputs](/guides/configure-authentication-and-runtime-inputs) for action-by-action requirements.

## Template gallery is degraded

Studio can display bundled starter metadata when the live gallery cannot load and states why:

- signed out: **“Sign in to Sapiom to browse the template gallery. The bundled starters below remain available.”**
- gallery unreachable: **“The template gallery is unreachable right now. The bundled starters below remain available.”**

Connecting an account is required before using either source. For an unreachable gallery, verify network access and retry the Templates destination later. A bundled starter is local source, but its MCP-backed setup still requires Sapiom authentication and can need npm access to install project dependencies; “bundled” does not mean the entire setup is network-free.

## History, Resume, and Continue here

### Expected history is missing

History is a union of Studio's session registry and the selected coding agent's history store for each exact working directory. Check these boundaries:

1. Open History from the same directory where the conversation ran. Symlinked launch paths are resolved as well as checked in their original form.
2. A session that ended before its first prompt may have a Studio row but no nonempty native conversation.
3. Studio's compact record and the coding agent's native history are independent; deleting either removes only the continuation mode it supports.
4. If one history source is unreadable, Studio logs that source failure and continues with its registry and any other healthy source. It cannot show a transcript that the owner no longer exposes.

Large Claude Code transcripts are read through bounded head/tail windows. Codex rollout metadata is read through bounded head windows. Studio's own indexed turn count can still populate a registry row; an absent count does not by itself mean the conversation is empty.

### Resume shows “Checking…”

This is the verification state, not a disabled Resume promise. Studio does not offer **Resume** until it confirms that the original coding agent still has a nonempty conversation for the recorded ID and directory. Wait for the check to settle:

- **Resume** uses the coding agent's native conversation when verification succeeds.
- **Continue here** appears when the coding agent cannot resume but Studio has a recorded reconstruction.
- a disabled Resume plus an explanation appears when neither source can continue the session.

If a native Resume fails after verification, re-open History to refresh the check. A transcript can be removed or become unreadable between verification and launch.

### Continue here lacks old context

Portable continuation is deliberately bounded. It opens a new conversation with the same coding agent, injects a recent-turn briefing, and tells the new session to inspect the repository. It does not restore model context, terminal state, or unlimited scrollback.

For a Studio-tracked source in the same directory, the recorded agent-project binding carries forward. A transcript-only row has no Studio binding to preserve. Confirm the active tab and bound agent before a direct action in either case.

If Studio cannot assemble any record, it does not label the fresh session as a continuation. Background summaries can improve the briefing, but they are optional and ephemeral; turning them off never disables the recent-turn fallback.

### Resume reports a context-file error

Before spawning the coding agent, Studio validates `.sapiom/harness-context.json`. It keeps a valid current file, migrates the valid legacy keys, and atomically reconstructs a missing, malformed, or mixed-schema file. Unlike ordinary best-effort context refreshes, this resume preparation fails closed so the coding agent cannot launch with a prompt that disagrees with the file.

Check that the session directory and its `.sapiom/` directory are writable, that the path is a regular file rather than a directory or symlink to an unexpected target, and that no other process is locking replacement. Retry Resume after correcting the filesystem issue.

## Canvas and Steps

### Nothing generated yet

Confirm all three facts:

- a live session is selected;
- that session is bound to the intended agent project; and
- the project dependencies are installed so Studio can extract the typed agent definition.

The Canvas is a deterministic projection and refreshes on binding, session start, and relevant code changes. Waiting for or prompting a coding agent is not required merely to render valid source.

### Render failed

The error panel is the honest result of graph extraction. Open **Details** for the recorded reason. **Retry** invokes the deterministic **Visualize** render again without asking a coding agent; use it after installing dependencies or fixing the type/definition error. **Ask coding agent to fix** sends the failure reason into the active Claude Code or Codex session and therefore requires that session to be ready.

An automatic refresh preserves an existing render when a new extraction fails, so a transient clone/install state does not erase the last usable board. An explicit Retry does not preserve stale success: if extraction still fails, it writes and shows the error panel you requested.

If the render file cannot be written, check write access to `<session-directory>/.sapiom/canvas/renders/`. Studio logs the write failure and cannot refresh the iframe until it can replace that file.

### Canvas looks stale after a code change

Verify the session binding first. A session's Canvas follows its bound agent, not whichever rail row was most recently focused. Then choose **Retry** to invalidate the extraction cache and render again. If the iframe loading skeleton remains after a bad or legacy document, Studio removes the opaque overlay after four seconds so the underlying board and its error state stay usable.

> **Note: Custom Canvas fallback.**
> Deterministic agent renders live under `.sapiom/canvas/renders/`. The sibling `.sapiom/canvas/index.html` is the unbound placeholder and optional custom Canvas. Studio seeds it only when missing and does not overwrite an existing custom file during deterministic rendering.

- [Agent Studio reference](https://docs.sapiom.ai/reference/agent-studio): Check exact flags, paths, retention, and keyboard shortcuts.
- [Build, deploy, and run failures](https://docs.sapiom.ai/troubleshooting/build-deploy-run): Diagnose agent checks, local execution, cloud builds, production starts, and inspection.
