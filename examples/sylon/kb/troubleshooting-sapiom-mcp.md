# Troubleshoot Sapiom MCP

Source: https://docs.sapiom.ai/troubleshooting/sapiom-mcp

Start at the earliest boundary that failed. Preserve the exact project directory and any definition, build, execution, or schedule ID already returned; retrying a later operation can create duplicate hosted work without fixing the original problem.

```text
connection → authentication → project → check → Local Run → link → deploy → run → inspect
```

## Tools are missing or disconnected

Inspect the coding-agent connection named `sapiom-project`. It should be enabled and start local package `@sapiom/mcp` through `npx`. If the connection was added after the coding-agent session started, restart that session so it refreshes `tools/list`.

The first uncached start needs Node.js 18 or newer and npm registry access. If the process exits immediately, run the coding-agent client's own MCP inspection command and read the process error before changing project files. Follow the exact [connection commands](/guides/connect-claude-code-with-mcp); the alias is a client label and tool approvals still use names such as `sapiom_dev_agents_check`.

## Authentication does not complete

Ask the coding agent to call `sapiom_status` first. It reports whether the process's selected environment has a cached credential and, when authenticated, the organization and tenant. The current result does not echo the environment name; read that from the MCP launch configuration when you need to distinguish environments.

- If signed out, call `sapiom_authenticate`, complete the browser flow, then call status again.
- If the browser opened but the tool timed out, finish or restart sign-in rather than assuming a late browser success reached the MCP process.
- If status names the wrong organization, or the launch configuration selects the wrong environment, sign out with `sapiom_logout`, select the intended environment, and authenticate again.
- If a project tool reports `NOT_AUTHENTICATED`, authenticate in the same machine and environment where that MCP process is running. Credentials on another computer or isolated coding-agent environment are not visible here.

Sapiom authentication is required before every supported project action, including scaffold, check, Local Run, and local preview configuration.

## The wrong project is used

Most project tools default `dir` to the MCP process's current working directory. Ask the coding agent to use the intended absolute directory when several projects or nested checkouts are open.

A Sapiom agent project has `index.ts`, `package.json`, and `sapiom.json` at the same project root. A missing, malformed, or misplaced `sapiom.json` prevents project discovery and hosted lifecycle operations. Do not copy a `definitionId` from another checkout to make an error disappear; link the intended project deliberately.

For scaffold and clone, the destination must be new or empty except for Agent Studio's reserved `.sapiom` directory. `DIR_NOT_EMPTY` protects existing work from being overwritten.

## Scaffold succeeded but check cannot resolve packages

`sapiom_dev_agents_scaffold` attempts dependency installation. Read its `dependenciesInstalled` result:

- `true` means the best-effort install completed.
- `false` means project creation still succeeded, but npm was missing, offline, timed out, or returned an error.

Ask the coding agent to diagnose and repair dependency installation in that project, then rerun the full check. Do not discard and recreate a correct scaffold merely because the soft install step failed.

Gallery and fork clones materialize source but do not promise an installed dependency tree. Let the coding agent read the cloned `AGENTS.md` and package manager metadata, prepare the checkout, and verify it before editing.

## Check fails or has unexpected side effects

`sapiom_dev_agents_check` typechecks, bundles, imports `index.ts`, finds one agent definition, derives its manifest, and validates the graph. Classify the first error before retrying:

| Layer                 | Typical evidence                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Dependencies or types | Missing package, export, or TypeScript diagnostic.                                             |
| Bundle or import      | Module resolution, syntax, or top-level runtime error.                                         |
| Definition            | Zero or multiple exported agents, or invalid schema/manifest data.                             |
| Graph                 | Missing transition target, invalid terminal/failure declaration, or other graph warning/error. |

Importing the definition executes top-level author code locally. Move accidental network calls, file writes, subprocesses, and environment-dependent initialization into step bodies before checking again.

## Local Run returns the wrong result

Read the domain result, not only the MCP transport:

1. Check run-level `outcome`, `output`, and `error`.
2. Inspect every step attempt and the effective parsed input.
3. Check captured Sapiom calls when present.
4. Require both `unusedStubs` and `stubWarnings` to be empty.

An explicit `stubs` argument replaces `.sapiom-dev/stubs.json`; it does not merge with the file. Stub by the step that makes the call and the exact capability path. A completed run with a nonempty diagnostic list is not a clean test.

> **Caution: Author code remains real.**
> Local Run stubs `ctx.sapiom.*`, not direct `fetch`, filesystem operations, child processes, environment reads, database libraries, or third-party SDKs. Those effects and charges can still occur on your machine.

Use the deeper [Local Run guide](/guides/test-locally) for stub precedence, retries, pauses, and the 1,000-advance guard.

## Link resolves the wrong identity

By default, `sapiom_dev_agents_link` reads the name from the checked `defineAgent` export. Use an explicit name only when that difference is intentional. With `create: true`, link can create a hosted agent; without it, a missing name is an error rather than implicit creation.

After success, inspect the same project's `sapiom.json` for the returned `definitionId`. If hosted resolution succeeded but the local write failed, fix file permissions before deploy so later tools do not lose the identity.

## Deploy fails or the wait ends

Before deploy, confirm the project is linked, checks cleanly, and belongs to a Git repository with at least one commit. Deploy packages the current working tree, including reachable uncommitted source; it does not push Git HEAD as the release identity.

Preserve `buildRunId` from every started deploy:

- A terminal failed build needs its build message and hint.
- A local wait timeout does not prove the build stopped. Call `sapiom_dev_agents_inspect` with `buildRunId` and the linked project directory.
- A newer deploy can supersede an earlier build. Follow the newer identity instead of trying to cancel through an unavailable control.

The full [build, deploy, and run troubleshooting guide](/troubleshooting/build-deploy-run) separates local bundle failures, link failures, terminal builds, and production readiness.

## Production start has no final output

This is expected. `sapiom_dev_agents_run` returns an `executionId` and `webappUrl` after enqueueing a run. Call `sapiom_dev_agents_inspect` with that execution ID to read its state.

Use `wait: true` for bounded polling. A wait lasts 45 seconds by default and is capped at 55 seconds. If the response says `waiting: true`, call inspect again with `wait: true`; do not wrap the tool in an unbounded sleep loop.

## Inspect omits a step's input, output, or logs

Execution inspection is compact by default. The step summary includes `has` flags and `sizes` for omitted heavy evidence. Select one step by name or order and request only the necessary fields with `include`, such as `input`, `error`, or `logs`. Add `attempt` when a retried step has several attempts.

Each expanded field has a character budget. A truncation marker points to the returned `webappUrl`, where the full recorded value can be inspected. See [Inspect](/guides/inspect) for the exact field set and evidence boundaries.

## A schedule is missing or fires incorrectly

Use `sapiom_dev_agents_cron_preview` with the intended IANA timezone before creating a recurring schedule. It validates and calculates occurrences without persisting anything.

- `sapiom_dev_agents_schedule` needs a deployed agent slug and fields consistent with `kind`.
- `sapiom_dev_agents_schedule_inspect` needs either `scheduleId` for one schedule or `definition` for a list.
- Recent fire entries can contain an `executionId`; inspect that production run to debug a failed occurrence.
- `sapiom_dev_agents_schedule_cancel` disables future fires only. It does not cancel a run already started.

## A released web-app preview tool appears

The `0.14.0` inventory contains three preview tools, but their direct hosted sequence is not a supported public workflow while preview execution bypasses the agent-run capability boundary. Do not invoke or retry that sequence based on its presence in an approval prompt.

If an older session already called `sapiom_dev_sandbox_preview`, preserve its result for diagnosis. It can successfully return a preview result whose domain `status` is `"failed"`, so returned build/start logs remain evidence even when the MCP transport succeeded. Do not interpret that response contract as approval for continued direct use.

## A result looks like JSON inside text

That is the released MCP result contract. Most tools put formatted JSON in the first text content item; account and feedback tools can return prose. Operational errors normally set the MCP error flag and encode `{ "error": { "code", "message", "hint" } }` in that text.

Do not confuse transport success with domain success. Local Run can return `outcome: "failed"`, and preview can return `status: "failed"`, without a malformed MCP response. The [tool reference](/reference/sapiom-mcp-tools) lists the expected result for each exact tool.

- [Sapiom MCP overview](https://docs.sapiom.ai/mcp/overview): Return to the task map, execution boundaries, and supported lifecycle.
- [Exact tool reference](https://docs.sapiom.ai/reference/sapiom-mcp-tools): Check released inputs, constraints, reviewed effects, returns, and failures.
