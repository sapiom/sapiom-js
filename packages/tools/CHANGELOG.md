# @sapiom/tools

## 0.32.0

### Minor Changes

- 065c9ca: `contentGeneration.images` / `contentGeneration.video`: `ImageCreateInput` and `VideoCreateInput` gain an optional `idempotencyKey` — a caller-supplied string forwarded verbatim as a top-level request field across the sync `create` and async `launch` paths. On platform deployments with content-generation idempotency support, keys are limited to 255 characters and repeated requests with the same per-tenant key return the existing generation. The SDK does not validate or deduplicate the key; deployments without platform support may ignore it.

## 0.31.0

### Minor Changes

- d7d480a: `models.run`: `ModelRunOutcome` gains an optional `warnings` array surfacing routing/honesty warnings when the platform reports them on the run result — e.g. a supplied `model` value the platform didn't recognize, which (with the SAP-2765 platform-side change) routes via the platform default instead of being silently dropped. Treat absent as no warnings.

## 0.30.0

### Minor Changes

- 5a8eeea: Execution results now expose the server's serving disclosure, in SKU vocabulary — plus structured-output and routing-label ergonomics for `llm.run`. Reissues #673 under the corrected disclosure contract (`servedClass`/`lane`, not the earlier draft's `servedModel`/provider `costUsd`).

  - `models.run` (`ModelRunOutcome`) and `models.coding.run` (`CodingRunOutcome`): new optional `servedClass` + `lane` (wire `served_class`, `lane`) — the billing class (size) the run's label resolved to and the lane it executed in. Never a model or provider id. `undefined`/`null` on older servers or when coding cannot observe it — never fabricated.
  - `llm.run` / `llm.redeem` / `llm.callSession`: new `LlmDisclosure` type describing the `served_class` / `lane` fields the server injects top-level into raw `/v2` non-streaming response bodies, plus a `readDisclosure()` helper returning the camel-cased `LlmDisclosureResult`. The response `model` field is unchanged and keeps echoing the requested label.
  - `llm.run` gains an optional `output: { name, schema }` field — the blessed tool-calling pattern for structured output, automated: it appends a forced tool call to the request and forces `tool_choice` onto it. `run`'s return type is unchanged either way (still the verbatim response); read the parsed value with the new `structuredOf()` helper. A new `textOf()` helper reads the plain-text reply, correctly skipping a `thinking` block that may precede it.
  - `model`/`label` fields across `llm.run`, `llm.submit`, `llm.createSession`, `models.run`, and `models.coding.run` are now typed as a soft union (`"smart" | (string & {})`, lint-safely spelled) for autocomplete, with JSDoc settled on "routing label" terminology: omit to let the platform choose, `"smart"` if you must pin, a raw provider model id is never honored.

  All additions are optional: existing consumers compile and run unchanged. On results from older servers the mappers and `readDisclosure` return `servedClass`/`lane` as `null` (unknown).

### Patch Changes

- 5a8eeea: `sapiom-agent-authoring` skill: teaches the LLM call-surface rule from step
  code (`llm.run` one-shot vs `models.run` platform-driven loop vs `agents.run`
  deployed-agent dispatch, with a worked example against the "reply with only
  JSON" + string-parsing mistake) and settles the platform's naming
  conventions (the overloaded "agent"/"run"/"task"/"session"/"dispatch" terms,
  and "label" as the author-facing term for a `model:` value). Synced across
  the canonical source, both scaffold templates, and the Claude Code plugin
  copy. `@sapiom/tools`: corrected stale `agent.run`/`agent.coding` naming in
  `models/index.ts`'s doc comments — the actual exported namespace is
  `models`.

## 0.29.0

### Minor Changes

- 04b7df5: Expose structured `CodingRunHttpError` details for failed coding requests and clarify repository-handle usage.

  Add guidance for handling deterministic coding-repository failures.

## 0.28.1

### Patch Changes

- aa7874b: content-generation (stub): `images.launch` / `video.launch` now also honor the sync verb's override key (`contentGeneration.images.create` / `contentGeneration.video.create`), so a step that moves from `create()` to `launch()` — the documented fix for long-running fan-outs — keeps its stub instead of silently falling back to the built-in default. Precedence: `<ns>.launch` (the call you wrote) wins, then `<ns>.create`, then the legacy `<ns>.run` spelling, which stays honored for back-compat (contentGeneration has no `run` method, but the key resolved before this release). Internally the four inlined media stub payloads collapsed into shared `stubImageResult` / `stubVideoResult` factories, so the `create` and `launch` defaults can no longer drift apart.
- 9544a0f: content-generation (stub): the `images.launch` / `video.launch` stubs no longer post-mutate `resolvedModel` onto the resolved result. Previously a frozen caller override under `contentGeneration.images.launch` / `contentGeneration.video.launch` threw a `TypeError`, and a non-frozen one had its `resolvedModel` silently clobbered by `input.model ?? "stub-model"` with the caller's object mutated in place. Now the fallback factory sets it, and the launch paths stamp it onto a **copy** of the resolved override — mirroring the routed client's `withDispatchCost` — so a caller-supplied override wins verbatim and is never touched, while `handle.resolvedModel`, `(await handle.wait()).resolvedModel`, and the durable resume payload always agree (when the override omits the field, all three fall back to `input.model ?? "stub-model"`, exactly like the routed path).

  Also: `toImageResumePayload` / `toVideoResumePayload` now omit `resolvedModel` instead of emitting an own key with value `undefined` when the input lacks it (mirroring the adjacent `cost` guard and the real webhook resume shape), and `MediaCostEnvelope` / `MediaResumeFields` are now named type exports of the package root alongside `VideoResultPayload` / `ImageResultPayload`.

  Docs: the content-generation README's storage example uses `count` (not the deprecated `numImages`), its `VideoResultPayload` block now shows the `resolvedModel` / `cost` resume metadata and `downloadUrlUnavailable`, and the cost-envelope section documents `cost.reference` and the out-of-band settled amount (`GET /v1/transactions/:id/costs`). The 0.27.0 changelog entry retroactively documents the `VIDEO_MODELS` deprecation that shipped with the video repoint.

- f70909f: models (stub): `models.launch` now honors the documented override keys. It previously resolved only the stale `agent.launch` / `agent.run` spellings — stranded by the agent→models half of the #167 rename — so a `models.launch` or `models.run` override was silently ignored by `launch()` (only `run()` honored `models.run`) and the built-in default was returned instead. `launch()` now consults `models.launch` > `models.run` > legacy `agent.launch` > `agent.run`; the legacy spellings stay honored for back-compat but now add a warning to the `warnings` sink (they sit one character from the unrelated `agents.*` namespace).

  The launch path also merges the override **over** the built-in defaults instead of using it verbatim: a partial stub (e.g. `{ "output": "..." }`, the documented minimal shape) keeps `status` / `error` / `result` filled so `handle.status()` works and the resume payload stays schema-valid; a function override returning a Promise is awaited; and an author-supplied `runId` is preserved across `wait()` and the resume correlation (in the real client `run()` _is_ `launch().wait()`, so both paths agree on the id). `models.run()` is unchanged (verbatim, as before).

## 0.28.0

### Minor Changes

- b768b18: content-generation: surface the E4 neutral param vocabulary on the SDK (SAP-2579)

  `contentGeneration.images.create` / `.launch` and `contentGeneration.video.create` / `.launch` now
  accept the neutral params as first-class typed fields — images: `aspectRatio`, `count`, `seed`,
  `negativePrompt`, `referenceImage`, `outputFormat`; video: `aspectRatio`, `resolution`, `duration`,
  `audio`, `seed`, `negativePrompt`, `referenceImage` — plus a `passthrough` escape hatch. The router
  validates each against the chosen model **before payment** and maps it to that model's provider
  format, so a caller can write `video.create({ prompt, aspectRatio: "9:16", audio: true, duration: 10 })`
  without any provider-specific param names. `numImages` and `params` keep working, now `@deprecated`
  in favour of `count` and `passthrough` (not drop-in aliases — the merge order is `params` < neutral
  fields < `passthrough`). New exported types: `AspectRatio`, `Resolution`, `OutputFormat`.

### Patch Changes

- beb0f6f: content-generation (stub): the offline `contentGeneration.images.create` and `video.create` stubs now
  return `resolvedModel`, matching the required `ImageGenerationResult` / `VideoGenerationResult` type and
  the real routed backend (which always echoes it). Previously the sync `create` stubs omitted the field
  behind an `as …Result` cast, so code reading `result.resolvedModel` under the stub got `undefined` while
  the type promised a `string`. The `launch` stubs already set it; this brings `create` in line
  (`input.model ?? "stub-model"`).

## 0.27.1

### Patch Changes

- 07a09c9: content-generation: `resolvedModel` is now optional on the durable workflow-resume payload — the backend omits it for uncataloged models (SAP-2650).

  `MediaResumeFields.resolvedModel` (shared by `VideoResultPayload` / `ImageResultPayload`) is now `resolvedModel?: string`. A real webhook-driven resume can legitimately arrive without it: for a non-cataloged model the gateway deliberately refuses to thread caller-controlled free text through this field on the resume payload (a stray `\n` would crash `fetch`, and the field would be spoofable), so it omits it best-effort — see SAP-2650.

  `resolvedModel` stays **required** everywhere the routed backend always echoes the alias (verbatim even for an uncataloged raw id): `VideoGenerationResult` / `ImageGenerationResult` and the sync / poll / launch handles are unchanged. Only the resume payload contract relaxes; `toVideoResumePayload` / `toImageResumePayload` keep emitting it from the (still-required) result field.

## 0.27.0

### Minor Changes

- 2b133e2: content-generation: surface the SAP-2576 per-generation cost envelope + `resolvedModel` across every media-result path

  Consumers (e.g. a platform re-billing generations to its own customers) can now price a generation without a second API call, consistently across synchronous image calls, polled results, launch handles, AND durable workflow resumes:

  - New `MediaCostEnvelope` (`estimateUsd` inline + the settled charge out-of-band via `cost.reference`) and `resolvedModel` on `ImageGenerationResult` / `VideoGenerationResult` and the `images.launch` / `video.launch` handles.
  - `resolvedModel` is **required** (the routed backend always echoes it — a cataloged raw id reverse-maps to its alias, an uncataloged one is echoed verbatim), matching the backend SAP-2576 contract. `cost` stays optional (quote/reference are best-effort).
  - The durable resume payload (`VideoResultPayload` / `ImageResultPayload`, via `toVideoResumePayload` / `toImageResumePayload`) now carries `resolvedModel` + `cost` (new shared `MediaResumeFields`), so a workflow step that bills in the **resumed** step — after generation — can still read `cost.reference`.
  - For video the envelope resolves at submit and is threaded from the dispatch handle onto the polled result (the gateway's queue passthrough carries neither).

  > Companion (backend): the Fal workflow-resume producer must emit `resolvedModel` + `cost` in the resume payload JSON for real webhook-driven resumes to carry them; the SDK mapper covers local stubs/tests only.

- beb3139: content-generation: route `video.create` / `video.launch` through the `/v1/capabilities/content.generation.video` router (SAP-2575)

  Video verbs now submit through the shared capability router (like images), so the SDK no longer builds the gateway-direct `/run/<model>` URL: `model` is a request-body field the router's adapter resolves server-side (a semantic alias like `"veo3-fast"`, or a raw provider id, defaulted when omitted), and authentication rides the `/v1` guard's `x-api-key` header. The public `video.create` / `video.launch` surface and the submit-then-poll-to-completion behavior are unchanged.

  With aliases resolving from the SDK, the `VIDEO_MODELS` raw-provider-id constants are now `@deprecated`: a pinned `VIDEO_MODELS.veo3Fast` keeps working (the adapter passes an already-resolved id straight through), but new code should pass the semantic alias (`"veo3-fast"`, `"kling-standard"`, …) directly to `model`.

  **Breaking — video's base URL moves to Core.** Video now resolves its base URL from Core like every other routed capability (`resolveCoreBaseUrl()` → `SAPIOM_BASE_URL` ?? `SAPIOM_API_URL` ?? `https://api.sapiom.ai`):

  - The content-generation-specific `SAPIOM_CONTENT_GENERATION_URL` override is **no longer read** for video — set **`SAPIOM_BASE_URL` / `SAPIOM_API_URL`** instead.
  - Any explicit `baseUrl` passed to `video.create` / `video.launch` must now point to **Core** (e.g. `https://api.sapiom.ai`), **not the Fal gateway**. A Fal-gateway URL here will now hit the wrong host.

## 0.26.2

### Patch Changes

- 9199d22: Align the `llm` capability's JSDoc label examples with the public Router
  taxonomy (`smart`, `small`, `medium`, `large`).

  The previous examples referenced model-name labels — `m2.7` (no longer a
  routable `/v2` label; copying that example now yields a `400`), `minimax-m3`,
  `sonnet`, `haiku`. The user-facing contract for the Router is the smart /
  size-tier label set, so the docstrings and inline examples now show those.
  No runtime behavior change: `model` / `label` remain free-form strings
  validated by the gateway.

## 0.26.1

### Patch Changes

- 1ac32ef: Keep public sandbox and routed-capability documentation provider-neutral while preserving required compatibility identifiers.

## 0.26.0

### Minor Changes

- cc1ac0c: file-storage: add `fileStorage.getPublicUrl(fileId)` — a pure helper that builds the durable, unauthenticated `/public/:id` permalink (the gateway re-signs a fresh URL on each hit), so callers can email or embed a link for an external recipient instead of a ~15-min presigned URL.

  content-generation: add `downloadUrlUnavailable?: boolean` to `ImageResultPayload` / `VideoResultPayload` outputs, so a resumed step can tell "URL omitted, re-fetch from fileId" from "no asset".

  Both are additive; no breaking changes. (Releases the changes merged in #504.)

## 0.25.0

### Minor Changes

- 27a1079: `contentGeneration.images.launch` — a dispatchable async surface for image generation, mirroring
  `video.launch`.

  The routed synchronous `images.create` holds its HTTP request open for the full generate+store,
  which meets Core's 30s router cap: a concurrent fan-out (`Promise.all` over N rows) drove every
  request in the batch past 30s, so the whole step 503'd on every retry. The backend already supported
  async image dispatch (`dispatch: 'async'`, SAP-1802) over the same fal-queue → webhook → resume rail
  as video, but the SDK never exposed it.

  `images.launch` submits with `dispatch: 'async'`, forwards the workflow resume token, and returns an
  `ImageLaunchHandle` (`requestId`, `dispatch`, and an inline `wait()`) — so the submit returns as soon
  as the job is enqueued and the 30s wall no longer applies. Pass the handle to
  `pauseUntilSignal(handle, { resumeStep })` to suspend a workflow step until the image is ready, or
  `await handle.wait()` to poll inline. Also exported: `IMAGE_RESULT_SIGNAL`, the `ImageResultPayload`
  shape a resumed step receives, and `toImageResumePayload`. `images.create` is unchanged. No backend
  change is required — the async completion→resume path is media-agnostic.

## 0.24.0

### Minor Changes

- a1e0e4f: Add `database.list()` to the `database` capability — a thin, read-only listing over `GET /v1/databases` that returns every database you own, each with connection credentials. It never creates, mutates, or removes anything. Use it to discover a handle you (or another of your workflows) already provisioned before deciding whether to reuse it. Available on the client (`sapiom.database.list()`) and as an ambient function (`import { database } from "@sapiom/tools"`).

## 0.23.0

### Minor Changes

- 55cde7f: Add the `browserAutomation` capability with sessions, screenshots, and identity management:

  - `browserAutomation.sessions.create()` — open a browser session; returns a `BrowserSession` with a CDP WebSocket (`cdpUrl`) for Playwright/Puppeteer.
  - `browserAutomation.sessions.createWithIdentity({ identityId })` — open a session pre-authenticated with a stored identity.
  - `browserAutomation.sessions.close(sessionId)` — close a session and settle its billing; returns a `SessionSettlement` with `capturedAmountUsd` and `creditsUsed`.
  - `browserAutomation.screenshot(input)` — one-shot screenshot (`url` required, billed at `$0.01`) or session-mode screenshot (`sessionId` provided, no per-call charge). The returned `url` is an absolute hosted image URL.
  - `browserAutomation.withSession(fn, opts?)` — the recommended pattern: opens a session, invokes `fn(activeSession)`, and always closes in a `finally` block so sessions never leak at the $1.00 ceiling. The `activeSession` carries all `BrowserSession` fields plus a session-bound `screenshot` convenience.
  - `browserAutomation.identities.create(input)` — store credentials for automatic login during sessions (free).
  - `BrowserAutomationHttpError` (`{ status, body }`) — thrown on non-2xx responses; re-exported from the barrel.
  - `"./browser-automation"` subpath export added to `package.json`.
  - `createStubClient()` wires a deterministic `browserAutomation` stub for every operation, including `withSession` invoking `fn` with a stub `ActiveSession`.

## 0.22.1

### Patch Changes

- 5f875de: Accept synchronous video responses and status-URL-only asynchronous handles from content-generation providers.

## 0.22.0

### Minor Changes

- 68d2352: New `llm` capability — routed LLM calls through the gateway's `/v2` routing front-end: `llm.run` (synchronous `POST /v2/anthropic/v1/messages`; `model` names a Sapiom routing label (omit for the account's `default_label`), capacity-aware with per-label never-fail fallback, billed against the caller's Sapiom API key at the edge), `llm.submit` (deferred-start `POST /v2/route/async`; returns a pausable `DispatchHandle` that grants a single-use link when capacity frees), and `llm.redeem` (spend the granted link). Exported on the client (`ctx.sapiom.llm`), the barrel, a `./llm` subpath, and the stub client.

  Sessions (Surface B, `/v2/sessions`) — the REST resource replacing the async+grant lane: `llm.createSession` (reserve deferred capacity from a plain JSON body: `label`|`model`, `deadlineMinutes`, `budget{maxTokens, ttlMinutes}`, optional webhook; returns a pausable `LlmSessionHandle` firing `LLM_SESSION_READY_SIGNAL`), `llm.getSession` (poll `pending → ready → active → expired|exhausted|failed`), `llm.callSession` (REPEATABLE drop-in calls against the session-scoped Anthropic/OpenAI paths with the normal Sapiom credential — no single-use token; ends with clean `session_expired`/`session_exhausted` terminals), and `llm.releaseSession` (early release). `submit`/`redeem` keep working until the migration completes. Stubbed in the stub client.

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
