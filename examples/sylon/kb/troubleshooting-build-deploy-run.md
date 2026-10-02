# Troubleshoot build, deploy, and run

Source: https://docs.sapiom.ai/troubleshooting/build-deploy-run

Start at the earliest failing boundary. A clean Local Run cannot repair a cloud build, and a new deploy cannot explain a local type error. Preserve the exact project directory, build ID, or execution ID returned at each transition.

```text
discover → prepare → check → Local Run → link/build → Prod Run → inspect
```

## Agent project is not discovered

Studio recognizes an agent project by a `sapiom.json` file directly inside its directory. The marker must parse as a top-level JSON object; an array, primitive, malformed file, or nested marker at the wrong scan depth is not a valid project.

Check the path you opened:

- **Open this agent** expects the selected folder itself to contain `sapiom.json`.
- **Find agents in this folder** scans the root plus three nested directory levels, skips `node_modules`, `.git`, `.sapiom`, `dist`, `build`, and `.next`, and does not follow symbolic links.
- `index.ts`, `package.json`, and `sapiom.json` must belong to the same project root used for checks and deploys.

If a scaffold completed but Studio still shows a plain folder, confirm that the coding agent called `sapiom_dev_agents_scaffold` in the intended destination rather than a child or sibling directory. Re-scan that exact parent after the marker exists.

## Install, typecheck, or check fails

1. **Confirm project setup.** Scaffold attempts dependency installation and reports `dependenciesInstalled`. If it is `false`, ask the coding agent to repair package setup in the exact project directory before retrying the full check. Gallery clones likewise need their checked-in package-manager metadata prepared before validation.

2. **Fix installed-API errors.** Import authoring primitives from `@sapiom/agent`, typed capability handles from `@sapiom/tools`, and Zod from `zod/v4`. Do not substitute remembered methods for the installed TypeScript surface.

3. **Run the full check.** Ask your coding agent to check the absolute project directory. The Sapiom MCP check typechecks, bundles and imports `index.ts`, finds exactly one exported agent definition, derives its manifest, and validates the graph.

4. **Read the failing layer.** A type error is different from a bundle/import error, missing or multiple definitions, a nonserializable manifest, or an invalid transition. Fix the first concrete error, then rerun both typecheck and check.
   The check imports bundled author code on your machine. Top-level network calls, file writes, environment reads, or process launches can therefore fail or produce side effects before any step runs. Move effects into step bodies unless import-time execution is intentional.

### Canvas works but check fails

This is possible. Deterministic **Visualize** favors a fast graph extraction and can skip the full TypeScript gate. Treat `npm run typecheck` plus `sapiom_dev_agents_check` as the authoring gate; a rendered diagram is not build evidence.

## Local Run fails

### Studio button rejects the input

The current **Local Run** button sends `{}`. If the entry schema has required fields without defaults, use `sapiom_dev_agents_run_local` with explicit input or add an intentional schema default; do not weaken a genuinely required production contract only to satisfy the button.

### The trace says `failed`

A Local Run failure is an execution outcome, not necessarily an HTTP or child-process crash. Read, in order:

1. the run-level `error`;
2. every step attempt's parsed input, output/error, and logs;
3. captured Sapiom calls; and
4. `unusedStubs` and `stubWarnings`.

Local and cloud execution default to three total attempts for one step, including the first. A `retry()` directive can therefore produce several trace rows before the terminal failure. Raising the local `maxAttemptsPerStep` is a test override only; it does not change the cloud ceiling.

### A capability result is unexpected

Local Run never calls the live Sapiom capability service. Resolution precedence is:

```text
explicit stubs argument → .sapiom-dev/stubs.json → typed built-in defaults
```

An explicit object replaces the project file rather than merging with it. Scope an override by the step name that makes the call, then the exact capability or singular-handle method path. Treat nonempty `unusedStubs` or `stubWarnings` as a failed test even if the agent reached `terminate(...)`.

### Local Run caused a real side effect

Only `ctx.sapiom.*` is replaced by stubs. Your step code runs as an ordinary child process on your machine and inherits the launch environment. Direct `fetch`, filesystem access, subprocesses, database SDKs, and third-party clients are real. It does not download cloud definition secrets. Remove or isolate the author-code effect before rerunning.

Agent Studio and Sapiom MCP require Sapiom authentication before they can start Local Run. After sign-in, the run itself makes no real Sapiom capability request and creates no Sapiom capability spend. If Local Run reports an authentication failure, reconnect the Sapiom account and retry.

## Deploy is disabled

Studio provides the disabled reason on the action:

| Reason                             | Remedy                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Connect your account first**     | Connect a Sapiom account from the account menu, then retry.                                                  |
| No bound agent/project             | Select the correct live tab and bind the intended discovered project.                                        |
| An earlier action is still pending | Wait for the one in-flight deploy to settle; Studio reuses the same in-flight operation for repeated clicks. |

Coding-agent readiness does not gate direct Deploy. Trust or authentication prompts inside Claude Code or Codex matter for prompt-driven authoring, not for this direct product action.

## Deploy fails

Before retrying, verify the checked project has:

- valid readable `sapiom.json` metadata;
- a Git repository with at least one commit;
- installed dependencies sufficient to bundle `index.ts` and its local imports; and
- a connected Sapiom account with access to the target organization.

### “Couldn't create the agent”

The failure occurred during first-link resolution or creation, before the cloud build phase. Fix the returned authentication, name, network, or service error and retry Deploy. If the link succeeded but writing `definitionId` back to `sapiom.json` failed, Studio reports a warning; correct local file permissions so later tools can reuse the identity instead of resolving it again.

### “Deploy failed”

The local project linked and the cloud build returned a terminal error. Read both the message and hint. Re-run local typecheck/check after correcting source or dependency declarations, then deploy again. A failed first build can still leave a valid `definitionId`; that means **Linked**, not runnable.

Deploy streams lifecycle lines over one HTTP response. The response can begin successfully and still end with `{ "phase": "error", ... }`. The terminal NDJSON line, not HTTP status alone, determines the build outcome. Studio persists the last failure after its toast is dismissed and labels the lifecycle **Deploy failed** until a later deploy succeeds.

### Build wait timed out or was superseded

- A local wait timeout does not prove the cloud build disappeared. Preserve `buildRunId` and inspect that build rather than immediately creating a duplicate.
- **Superseded** means a newer deploy replaced this build while it was in flight; follow the newer build.
- **Cancelled** is terminal, but Agent Studio and Sapiom MCP do not provide a public build-cancel action.

Every successful redeploy creates a new immutable build. It does not rewrite the build pinned to an execution already started.

## Prod Run is disabled or will not start

| Gate           | Evidence and remedy                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication | Connect the Sapiom account. The local boot token cannot authorize a cloud run.                                                                     |
| Project link   | A `definitionId` must be present for the intended project. Deploy handles first link when needed.                                                  |
| Ready build    | Only an active cloud build whose projected status is `ready` enables **Prod Run**. **Linked**, **Building**, or **Deploy failed** is not runnable. |
| Input          | Studio sends `{}`. Supply required custom input through `sapiom_dev_agents_run` or dashboard **Run once**, or define intentional defaults.         |

The production-start response `{ "executionId": "..." }` proves only that the execution was enqueued. It is not agent output. Preserve the ID and inspect the run to terminal state or an external-signal pause.

If start itself returns an error, use its service-provided reason before deploying again. A new deploy helps only when the problem is the selected build; it does not fix authorization, invalid effective input, quota, or a service outage.

## Studio run inspection stops updating

Studio polls the run-state endpoint every two seconds, never overlaps requests for the same poller, and resets its failure count after a successful response. One or two transient failures are retried without discarding the last stored snapshot. After three consecutive failures, Studio stops that poller and shows:

> Run inspection is temporarily unavailable. Open the run in the Sapiom dashboard or start a new Prod Run to retry.

For an already-started execution, open the dashboard using the same definition ID and execution ID. Starting a new Prod Run creates another live, potentially metered execution; it is not a read-only retry of the existing one.

The dashboard route has this shape:

```text
https://app.sapiom.ai/agents/<definition-id>/runs/<execution-id>
```

If you used Claude Code or Codex, ask it to inspect the execution and wait for a final state. Sapiom MCP's bounded wait can expire; ask it to continue rather than wrapping the request in an unbounded shell polling loop.

## Production run fails

Use the inspector to separate these identities:

- `buildRunId`: the immutable artifact this execution pinned;
- execution `version`: an optimistic-lock counter, not a deploy version;
- step attempt: the exact parsed input, output/error, logs, capability events, shared state, and directive for that try; and
- run-grain charge: fetched separately by the dashboard, not attributed to one step.

Reproduce the failing step locally only after capturing its effective input and replacing each live Sapiom call with a deliberate stub. A passing stubbed reproduction still does not prove provider availability, production secrets, or cloud runtime behavior.

> **Caution: No generic operate controls.**
> Do not look for general pause, resume, cancel, or retry buttons for an arbitrary production run. A run deliberately waiting for a human/webhook signal can expose its specific **Resume run** form; dispatched-capability callbacks resume automatically. Neither is a generic run-control surface.

- [Build](https://docs.sapiom.ai/guides/build): Review the typed definition, full check, graph rules, and stable result fields.
- [Test locally](https://docs.sapiom.ai/guides/test-locally): Control stubs and interpret local trace evidence before crossing the cloud boundary.
- [Deploy](https://docs.sapiom.ai/guides/deploy): Understand linking, synthesized source, build states, and immutable build identity.
- [Inspect](https://docs.sapiom.ai/guides/inspect): Read a cloud execution's pinned build, evidence, lineage, and run-grain charge.
