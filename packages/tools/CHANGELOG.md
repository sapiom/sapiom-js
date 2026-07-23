# @sapiom/tools

## 0.21.0

### Minor Changes

- d00b9e3: Add `speech` capability: text-to-speech, sound effect generation, and voice listing.

  - `speech.textToSpeech.create({ text, voice?, storage?, params? })` — generate speech audio from text. Returns `url`, `expiresAt`, and `fileId` (when `storage` is passed).
  - `speech.soundEffects.create({ text, durationSeconds?, storage?, params? })` — generate a sound effect from a text prompt.
  - `speech.voices.list()` — list available voices (returns `voiceId` and `name` per entry).
  - `SpeechHttpError` — error class (with `status` and `body`) thrown on non-2xx responses, re-exported from the barrel.
  - Subpath export `@sapiom/tools/speech` available for direct imports.
  - `storage` param on `textToSpeech.create` and `soundEffects.create` persists audio to Sapiom file storage; the result carries `fileId` for durable retrieval via `fileStorage.getDownloadUrl(fileId)`.

## 0.20.1

### Patch Changes

- ebb0342: Forward activity-trace context on capability and model calls. `Attribution` gains `activityTraceId`, `parentSpanId`, `executionId`, and `stepOrder` — emitted as `x-sapiom-activity-trace-id` / `x-sapiom-parent-span-id` / `x-sapiom-execution-id` / `x-sapiom-step-order`, and read ambiently from the matching `SAPIOM_*` env vars (`attributionFromEnv`) — so calls nest under the calling run and step. Applied once at the shared transport, so every capability inherits it.

  `activityTraceId` is deliberately a **separate field/header from `traceId`**: `traceId` (`x-sapiom-trace-id`) remains the Core transaction trace, while `activityTraceId` (`x-sapiom-activity-trace-id`) is the client-minted activity/execution trace — kept apart so the two never collide on one header.

  Deprecates `agentName`, `agentId`, and `traceExternalId` (a free-form label / legacy correlation field). They still forward for backward compatibility.

## 0.20.0

### Minor Changes

- 4cf0156: Forward activity-trace context on capability and model calls. `Attribution` gains `parentSpanId`, `executionId`, and `stepOrder` — emitted as `x-sapiom-parent-span-id` / `x-sapiom-execution-id` / `x-sapiom-step-order`, and read ambiently from `SAPIOM_PARENT_SPAN_ID` / `SAPIOM_EXECUTION_ID` / `SAPIOM_STEP_ORDER` (`attributionFromEnv`) — so calls nest under the calling run and step. Applied once at the shared transport, so every capability inherits it.

  Deprecates `agentName`, `agentId`, and `traceExternalId` (a free-form label / legacy correlation field). They still forward for backward compatibility; prefer `traceId` plus the new fields.

## 0.19.0

### Minor Changes

- e446a4a: Align the memory surface to the v1 wire contract: `MemoryMetadata` is a flat scalar map (`string | number | boolean`), retrieval `strategy` is `semantic | keyword | hybrid`, and the offline stub mirrors the wire's runtime rejections for invalid metadata shapes and strategy values (400s). Docs now recommend namespace-first modeling for always-filtered dimensions.

## 0.18.0

### Minor Changes

- afc77e3: Add a READ-ONLY `vault` namespace (`vault.list/get/getMany/getAll` + `ctx.sapiom.vault`) against the vault gateway's v2 API. List returns key names only; get maps a 404 to `null`. No set/delete by decision (SAP-1471) — writing secrets stays in the dashboard / `@sapiom/core` `VaultAPI`.

## 0.17.2

### Patch Changes

- 41e9ecd: Add sandbox preview primitives to the `sandbox` capability.

  - `deployPreview({ source, build, start, port, env })` triggers the server-side deploy op and returns the live preview URL. `source` is either a local upload or a Sapiom git repository (`{ kind: 'git', repo, ref? }`), so an in-process caller with an existing repo can deploy in one call.
  - `uploadDir(localDir, { ignore })` ships a local directory to the sandbox (ignore-aware walk), the companion to the upload source.
  - Renames `createPreview` to `createPublicUrl` — the method exposes a sandbox port at a public URL and is not a 1:1 wrapper of any single provider's naming.

## 0.17.1

### Patch Changes

- 7fa17d1: Align agent run and schedule requests with the current API endpoints. This also fixes `@sapiom/tools` `schedules` operations (create/list/get/cancel), which were targeting an outdated endpoint. Public function signatures are unchanged.

## 0.17.0

### Minor Changes

- aee376a: Emit `capability.call` usage analytics from the capability transport via `@sapiom/analytics-core`.

  Every capability HTTP call now enqueues one `capability.call` event at the transport choke point, carrying the capability path/name (the routed capability id, e.g. `web.scrape`, or the request path), the request URL path (query strings and fragments are stripped, never recorded), HTTP status, duration, request size, and the transport's attribution fields (agent, trace, metadata). Request and response bodies are never captured. The emitted `sdk_version` comes from a build-time constant generated from package.json, so it survives bundling.

  Analytics ships dark: unless a collector endpoint is configured the emitter is a silent no-op — zero network calls, zero disk writes. Events are enqueued synchronously and delivered in background batches, so nothing is ever awaited, thrown, or slowed on the call path; capability behavior is byte-identical with telemetry on, off, or the collector unreachable. Opt out any time with `SAPIOM_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`.

  Adds `Sapiom.shutdown(): Promise<void>` (additive): flushes buffered events and detaches the emitter's process exit hook. Call it once per client in hosts that construct many clients per process (e.g. an engine worker creating a per-execution client) so exit hooks don't accumulate; it's idempotent, never rejects, resolves immediately when there's nothing to release, and covers clients derived via `withAttribution` (the stub client implements it as an immediate resolve).

### Patch Changes

- Updated dependencies [3f25008]
- Updated dependencies [55462b3]
  - @sapiom/analytics-core@0.2.0

## 0.16.0

### Minor Changes

- cc1261e: Rename the composition SDK to **agents** and the coding/LLM capability to **models**.

  **Breaking — the package names changed. Install the new names; the old ones are deprecated.**

  - Packages: `@sapiom/orchestration` → `@sapiom/agent`, `@sapiom/orchestration-core` → `@sapiom/agent-core`, `@sapiom/orchestration-runtime` → `@sapiom/agent-runtime`. (`@sapiom/create-orchestration` is retired — scaffold with the CLI or the developer MCP.)
  - API: `defineOrchestration` → `defineAgent`; `Orchestration*` types/errors → `Agent*`.
  - `@sapiom/tools`: the `agent` capability namespace is now `models` (e.g. `sapiom.models.coding`); the `orchestrations` namespace is now `agents`.
  - CLI: `sapiom orchestrations …` → `sapiom agents …`.
  - Developer MCP tools: `sapiom_dev_orchestrations_*` → `sapiom_dev_agents_*`.

## 0.15.0

### Minor Changes

- 8fd3f71: `contentGeneration` image + video outputs now include a ready-to-use `downloadUrl` (and its `downloadUrlExpiresAt`) alongside the durable `fileId` when `storage` is requested.

  - `GeneratedImage` and `GeneratedVideo` gain an optional `downloadUrl` — a short-lived, ready-to-use signed URL for the persisted output, surfaced inline on the result so you don't need a follow-up `fileStorage.getDownloadUrl(fileId)` call just to fetch it — plus `downloadUrlExpiresAt` (ISO) so the field is self-describing. It expires; `fileId` remains the durable reference (re-mint a fresh URL any time via `fileStorage.getDownloadUrl(fileId)`).
  - `VideoResultPayload.outputs[]` (delivered to a step resumed from `pauseUntilSignal`) carries `downloadUrl` + `downloadUrlExpiresAt` too, and `toVideoResumePayload` maps them through.
  - The provider-hosted `url` is now documented as the raw, possibly short-lived / unauthenticated URL — prefer `downloadUrl` (ready to use) or `fileId` (durable) when you requested `storage`.
  - `createStubClient()` mirrors the new fields: stubbed image / video outputs include a `downloadUrl` + `downloadUrlExpiresAt` when `storage` is passed.

  Backward compatible: the new fields are optional and additive; the existing `fileId` / `url` / `storageError` fields are unchanged.

## 0.14.1

### Patch Changes

- bfd1b84: Expose the nested `dns` namespace on the `domains` capability so `domains.dns.*` (create, list, get, update, delete) works when the `domains` namespace is imported directly, matching the client and the documented `@example`s.

## 0.14.0

### Minor Changes

- aaf633c: Add the `memory` capability with `append`, `recall`, `sweep`, `get`, and `forget`. The SDK mirrors the gateway's camelCase contract, including grouped `store` selectors, `ADDED`/`NOOP` append decisions, temporal recall weights, metadata filters, dry-run sweep, and `MemoryHttpError` for non-2xx responses.

## 0.13.0

### Minor Changes

- cc2bde2: Add the `domains` capability — register domain names and manage their DNS. Check availability and pricing, register (buy) a domain for a year, renew it, list and inspect the domains you own, and start a transfer out; plus a nested `dns` group to create, list, get, update, and delete DNS records on a domain you own. Available as `sapiom.domains.*` on the client, as the ambient `domains` namespace, and from the `@sapiom/tools/domains` subpath. `register` and `renew` charge on success. Failed requests throw `DomainsHttpError`.

## 0.12.0

### Minor Changes

- 019ef30: Repoint `scrape`, `emailSearch.*` (find/verify/domainSearch), and `contentGeneration.images.create` onto the Capability Router: each now sends `POST /v1/capabilities/<dotted-id>` on the single Core base URL instead of a provider-gateway subdomain.

  A new shared `capabilityCall(id, req, opts)` seam (in `_client/`) is the one place the routed-call contract lives — building the `/v1/capabilities/<id>` request, sending the `x-api-key` credential header, resolving the Core base URL **at call time** (no per-capability URL knob, no module-const import freeze), and mapping non-2xx to the capability's typed error. `web.search` is refactored onto it, and the three migrated verbs route through it too.

  Public verb names and signatures are unchanged (non-breaking); request/response shapes are mapped to the router's normalized DTOs internally. The deferred async/stateful capabilities (video, sandboxes, agents, …) keep their existing provider-gateway path.

## 0.11.0

### Minor Changes

- 84e44e2: Add the `email` capability — programmatic transactional email. Create and manage inboxes, send/list/get messages, reply/reply-all/forward, register and verify custom sending domains, list and read conversation threads, and register webhooks for inbound events. Available as `sapiom.email.*` on the client, as the ambient `email` namespace, and from the `@sapiom/tools/email` subpath. Failed requests throw `EmailHttpError`.

## 0.10.2

### Patch Changes

- b8f19b8: `orchestrations.launch({ at })`: from inside a step, schedule a child orchestration to run at a future time and pause on the returned handle — the step resumes with the child's result once the scheduled run finishes (delayed dispatch). Immediate `launch`/`run` are unchanged.

## 0.10.1

### Patch Changes

- a85e665: Add schedules: run a deployed orchestration on a recurring cron schedule or once at a set time.

  - `@sapiom/orchestration-core`: `createSchedule`, `listSchedules`, `getSchedule`, `cancelSchedule`, and `previewCron`.
  - `@sapiom/tools`: a `schedules` namespace (`create`, `list`, `get`, `cancel`).
  - `@sapiom/cli`: `sapiom orchestrations schedule create | list | inspect | cancel | preview`.
  - `@sapiom/mcp`: schedule tools — create, inspect (list/detail + recent fires), cancel, and cron preview.

## 0.10.0

### Minor Changes

- 6ebf569: **Breaking:** `fileStorage` now uses a single `fileSize` field, matching the service contract.

  Previously `upload` 400'd and metadata sizes came back `undefined` because the SDK was on an older field shape.

  - `UploadInput.expectedFileSize?: number` → `fileSize: number` (now **required** — the service rejects uploads without it).
  - `FileMetadata.expectedFileSize` / `actualFileSize` → a single `fileSize: string`.

  To migrate: pass `fileSize` on `upload(...)`, and read `fileSize` (a string) instead of `expectedFileSize` / `actualFileSize` on returned metadata.

## 0.9.0

### Minor Changes

- 0361fa7: Add `SAPIOM_SERVICES_BASE` — one env var that re-homes every capability gateway at once.

  Each capability resolved its base URL independently (`SAPIOM_<CAP>_URL || "https://<subdomain>.services.sapiom.ai"`). Pointing the whole SDK at a non-prod stack meant setting a separate variable for every capability, and any capability you forgot silently fell back to prod. Now all capabilities resolve through `resolveServiceUrl(subdomain, override)`:

  1. an explicit per-capability `SAPIOM_<CAP>_URL` still wins (unchanged, back-compat);
  2. else `SAPIOM_SERVICES_BASE` re-homes every capability by swapping the host suffix and preserving the subdomain (e.g. `SAPIOM_SERVICES_BASE=http://services.localhost:3100` → `http://fal.services.localhost:3100`, `http://git.services.localhost:3100`, …);
  3. else the production default `https://<subdomain>.services.sapiom.ai` (unchanged).

  Accepts a full origin or a bare `host[:port]` (assumed https). Production behavior is unchanged when `SAPIOM_SERVICES_BASE` is unset.

### Patch Changes

- 30bac1c: Add the general `agent` capability — an instant, in-server agent (prompt → text), optionally calling tools on remote MCP servers. No sandbox.

  ```ts
  import { agent } from "@sapiom/tools";

  // run inline:
  const res = await agent.run({ prompt: "Summarize this transcript: …" });
  console.log(res.output);

  // or dispatch from a workflow step and resume when it finishes:
  const handle = await agent.launch({
    prompt: "…",
    mcps: [
      {
        /* … */
      },
    ],
  });
  return pauseUntilSignal(handle, { resumeStep: "use-result" });
  ```

  `run` resolves to an `AgentRunResult` (`output` carries the final text); `launch` returns a handle usable with `pauseUntilSignal`. Also exports `AGENT_RUN_RESULT_SIGNAL` for the static `pause` declaration on a step. This sits alongside the existing `agent.coding` capability.

- 30bac1c: Add `sandboxes.get` and `sandboxes.list` — read-only access to a sandbox's metadata and current status.

  ```ts
  import { sandboxes } from "@sapiom/tools";

  const info = await sandboxes.get("build-01"); // { status, url, tier, expiresAt, … }
  const all = await sandboxes.list();
  ```

  Both return plain `SandboxInfo` metadata (status, URL, tier, TTL), not a live handle — use `attach(name)` to operate on a sandbox. Handy for checking readiness, or whether a sandbox already exists before creating one. `get` throws if the named sandbox does not exist.

## 0.8.1

### Patch Changes

- bfd2382: Validate the `duration` input in `database.create` and reject invalid values before the request.

## 0.8.0

### Minor Changes

- 2b94dff: Add the `database` namespace for on-demand Postgres databases:

  - `database.create` — provision a database for a chosen `duration`, returned with direct connection credentials (`connection.connectionString`, `host`, `port`, `username`, `password`, `databaseName`).
  - `database.get` — retrieve a database by its id or handle.
  - `database.delete` — delete a database by its id or handle.

  Results use normalized camelCase types, and a typed `DatabaseHttpError` (`{ status, body }`) is thrown on non-2xx responses.

- ac71754: Add the `search` namespace with provider-agnostic operations:

  - `search.webSearch` — web search returning normalized `{ query, answer?, results }`.
  - `search.scrape` — fetch a URL as clean Markdown/HTML with page metadata.
  - `search.emailSearch.findEmail` / `verifyEmail` / `domainSearch` — find, verify, and discover professional email addresses for a domain.

  Results use normalized camelCase types, and a typed `SearchHttpError` (`{ status, body }`) is thrown on non-2xx responses.

- f078ed5: Add `contentGeneration.video.launch()` — the dispatchable surface for video generation.

  - `contentGeneration.video.launch(input)` submits a video generation job and returns a `VideoLaunchHandle` immediately. Pass the handle to `pauseUntilSignal(handle, { resumeStep })` to suspend a workflow step until the video is ready, or call `handle.wait()` to block inline.
  - `VideoLaunchHandle` satisfies `DispatchHandle` — `dispatch.correlationId` and `dispatch.resultSignal` are the join keys the orchestration engine uses to resume a paused step.
  - `VIDEO_RESULT_SIGNAL` (`"contentGeneration.video.result"`) is the capability-stable signal constant; use it in the static `pause: { signal }` declaration of a workflow step.
  - `VideoResultPayload` and `toVideoResumePayload` describe the payload a resumed step receives across the wire boundary (plain JSON with `outputs[].fileId` / `outputs[].storageError`).
  - Prompt-guard hardening: `images.create`, `video.create`, and `video.launch` now throw a typed error immediately when `prompt` is null, empty, or not a string — before any network request is made.
  - `createStubClient()` wires `contentGeneration.video.launch` as a dispatchable stub that auto-registers a resume payload when `signals` is provided, enabling local workflow testing.

## 0.7.0

### Minor Changes

- a3cc368: Add `contentGeneration.video.create` — generate a video from a prompt, with an optional `storage` param. Video generation is asynchronous: `create` submits the job and polls until the result is ready (configurable `pollIntervalMs` / `timeoutMs`), then resolves — so you `await` it just like `images.create`. When `storage` is passed, the output is persisted and the returned `video` carries a `fileId`. camelCase surface, mapped from the wire.

## 0.6.2

### Patch Changes

- 9fca481: Forward the workflow resume token explicitly via `createClient({ resumeToken })`.

  `agent.coding.run`/`launch` send the per-execution resume token as the `x-sapiom-workflow-token` header so the gateway can resume the paused workflow step. Previously the token was read ONLY from `process.env.SAPIOM_CAPABILITY_RESUME_TOKEN` — fine for the sandbox runtime (which injects that env var) but invisible to the engine's in-process runtime, which must not set process-global env (it would bleed across concurrent step executions sharing the worker). `TransportConfig` now accepts an optional `resumeToken`; the client prefers it and falls back to the env var, so the sandbox path is unchanged and the in-process runtime can pass the token per-call. Additive and backward-compatible.

## 0.6.1

### Patch Changes

- 3d45ec6: Document the `orchestrations` capability: add it to the README's Capabilities table + intro, and add a per-capability `src/orchestrations/README.md` (run a deployed orchestration, or dispatch one from a step and pause on its result).

## 0.6.0

### Minor Changes

- b2c5612: Add the `orchestrations` capability — run a deployed orchestration by slug, or dispatch one from a workflow step and pause on its result.

  ```ts
  import { orchestrations } from "@sapiom/tools";

  // run inline:
  const result = await orchestrations.run({ definition: "enrich-lead", input });

  // or dispatch from a step and resume when it finishes:
  const child = await orchestrations.launch({
    definition: "enrich-lead",
    input,
  });
  return pauseUntilSignal(child, { resumeStep: "use-result" });
  ```

  `launch` returns a handle usable with `pauseUntilSignal`; the resumed step receives an `OrchestrationRunResultPayload` (validate with `orchestrationResultSchema`). Also exports `ORCHESTRATIONS_RESULT_SIGNAL` for the static `pause` declaration on a step.

## 0.5.0

### Minor Changes

- 5c974b1: Add the `contentGeneration` capability — media generation (images today; video and audio to come) with an optional `storage` param that persists each output to Sapiom file storage (each generated image comes back annotated with its own `fileId`, or `storageError`). Exposes `contentGeneration.images.create({ prompt, numImages?, storage? })` via `createClient()`, the ambient `contentGeneration` namespace, or the `@sapiom/tools/content-generation` subpath. Failed requests throw `ContentGenerationHttpError`. Pairs with `fileStorage` — pass `storage` to persist outputs with no extra plumbing.

## 0.4.0

### Minor Changes

- e17b2d1: **BREAKING (`@sapiom/tools`):** align the coding-run resume payload with the shape a resumed step actually receives. `CodingResultPayload` now carries `executionEnvironment: { type, id } | null` instead of `sandbox: { name, workspaceRoot }`. Re-attach a resumed run's sandbox with `ctx.sapiom.sandboxes.attach(result.executionEnvironment.id)` (for a `blaxel_sandbox`).

  Adds `codingResultSchema` (runtime validation of the resume payload), `toResumePayload`, `ExecutionEnvironmentRef`, and `EXECUTION_ENVIRONMENT_BLAXEL_SANDBOX`. The stub client now emits the same payload shape a resumed step receives, so a step written against the local loop runs identically once deployed.

  The `coding-pause` template and its guidance are updated to the new shape.

## 0.3.0

### Minor Changes

- 704c9ac: Make the local development loop (`run_local`) production-faithful and trustworthy for the dispatch/pause pattern (`agent.coding.launch` + `pauseUntilSignal`).

  - Stub capability handles now survive JSON serialization, so a paused/resumed coding workflow runs end-to-end locally instead of failing with an opaque `'sandbox.toJSON' is not a method or field` error.
  - The payload a paused step resumes with is delivered as plain JSON — the same shape production sends over the wire — so authors re-attach handles by name (`sandboxes.attach(...)`) locally exactly as they would in prod.
  - `@sapiom/tools` exports `CodingResultPayload`: the shape a step resumed from `pauseUntilSignal(codingHandle, …)` receives, so resumed steps can be annotated instead of hand-rolling the type.
  - Stubbing a handle-returning capability with plain JSON no longer strips the handle's instance methods (e.g. `repo.pushFromSandbox`), and `repositories.list` stubs are coerced and shape-checked.
  - A dispatched `launch()` accepts the `agent.coding.launch` stub key as well as the shared `agent.coding.run` (ordered candidate resolution), so the stub key matching the call the author wrote takes effect.
  - `run_local` now reports `unusedStubs` (a supplied key that matched no call) and `stubWarnings` (a key that matched but carried the wrong shape), surfacing stubs that silently didn't take effect; the MCP `run_local` also serializes its result defensively.
  - New `coding-pause` scaffold template for the launch + pause + resume pattern, and AGENTS docs documenting the resume-input contract, list stub item shape, failure-branch stubbing, and step determinism under replay.

## 0.2.0

### Minor Changes

- 7f6859e: Add the `fileStorage` capability — tenant-scoped object storage with presigned URLs. Exposes `upload`, `getDownloadUrl`, `list`, `setVisibility`, and `delete` via `createClient().fileStorage`, the ambient `fileStorage` namespace, or the `@sapiom/tools/file-storage` subpath. Failed requests throw `FileStorageHttpError`. You transfer the bytes yourself via the presigned URLs.

## 0.1.3

### Patch Changes

- 2126d96: `repositories.pushFromSandbox` now always publishes the agent's work — it
  commits any pending changes and pushes the current commit, so your work reaches
  the repo whether the agent left changes uncommitted, already committed them, or
  both. (Previously it skipped the push when there were no uncommitted changes.)
  The result now includes `branch` alongside `pushed` and `sha`.

## 0.1.2

### Patch Changes

- be3886e: Add the dispatch→pause→resume authoring surface for long-running capabilities.

  `@sapiom/tools`: new `DispatchHandle` contract + `CODING_RESULT_SIGNAL`; coding-run
  handles now carry a `dispatch` member, and `launch` forwards the engine-injected
  `SAPIOM_CAPABILITY_RESUME_TOKEN` as the `x-sapiom-workflow-token` header.

  `@sapiom/orchestration`: `pauseUntilSignal` accepts a `DispatchHandle |
Promise<DispatchHandle>` so a step can pause on a launched capability with
  `pauseUntilSignal(ctx.sapiom.agent.coding.launch(...), { resumeStep })`.

  Additive and non-breaking — standalone `agent.coding.launch` is unchanged.
