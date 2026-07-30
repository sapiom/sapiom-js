# Deploy Auto-Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking Deploy on a template-cloned agent that has no remote counterpart resolves-or-creates the remote agent first, then builds — instead of failing with a 409.

**Architecture:** One new branch inside `POST /api/workflows/:id/deploy` in `packages/harness/src/server/actions.ts`. When `sapiom.json` carries no `definitionId`, the route emits a new non-terminal `linking` NDJSON line, calls agent-core's `link({ name, create: true })` (which matches an existing remote definition by name/slug before creating one), caches the result in `sapiom.json`, and continues into the existing build path. `link` and `writeConfig` arrive as injected core deps so no test touches the network or the filesystem. The agent's name comes from an optional `resolveDefinitionName` seam, wired in `server/index.ts` to the already-warm canvas extraction cache.

**Tech Stack:** TypeScript (ESM, NodeNext), Express, Vitest, pnpm workspaces, `@sapiom/agent-core`, React (SPA).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-30-deploy-auto-link-design.md`. Read it before Task 1.
- Package under change: `@sapiom/harness`. `@sapiom/agent-core` is **not** modified — its `deploy()` must keep never writing `sapiom.json`.
- Scope is the harness HTTP route only. Do **not** change `packages/cli/src/commands/agents/deploy.ts` or the MCP deploy tool; their `NOT_LINKED` behaviour is intentional.
- The already-linked path must stay byte-identical on the wire: `building` → `ready`/`error`, with no `link` call. Every existing test in `src/server/actions.test.ts` except the two named in Task 1 and Task 2 must pass untouched.
- `actions.ts` must not import from `core/canvas-*` or the workflow registry. It stays decoupled via injected deps and seams (this mirrors the existing `resolveWorkflow` / `coreDeps` / `runLocalSpawn` seams).
- Terminal stream lines stay exactly one per stream: `ready` or `error`. `linking` is non-terminal.
- Run every command **from the repo root** — never `cd` (see `packages/harness/CLAUDE.md`).
- No new desktop-packaging hazard is permitted or expected: `link` is a plain network call, and the only subprocess involved is the existing `runManifestCheck`, which already translates asar paths and sets `ELECTRON_RUN_AS_NODE`. Do not add a new `asarUnpack` entry or a `smoke.ts` check — if you find yourself needing one, stop and re-read the spec.
- Test command shape: `pnpm --filter @sapiom/harness exec vitest run <path> -t "<name>"`.
- Baseline for this worktree: 102 files / 1578 tests, all passing. Any other failure you see is yours.
- Commit after each task. Conventional-commit prefixes (`feat:`, `fix:`, `test:`, `refactor:`, `docs:`).
- Do not add attribution/co-author trailers to commits (disabled globally for this repo).

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `packages/harness/src/server/actions.ts` | Modify: three-way config read, `linking` event, auto-link branch, `link`/`writeConfig` deps, `resolveDefinitionName` seam, `ActionWorkflow.name` | 1, 2 |
| `packages/harness/src/server/actions.test.ts` | Modify: rewrite the two tests that assert the old 409, add auto-link coverage | 1, 2 |
| `packages/harness/src/core/definition-name.ts` | **Create**: `resolveManifestName(projectDir, extract?)` — reads `graph.manifestName` from the canvas extraction cache, null on any failure | 3 |
| `packages/harness/src/core/definition-name.test.ts` | **Create**: unit tests for the above with an injected fake extractor | 3 |
| `packages/harness/src/server/index.ts:1166-1177` | Modify: pass `resolveDefinitionName` + `name` into `createActionsRouter` | 3 |
| `packages/harness/web/src/lib/api.ts` | Modify: mirror the `linking` member in the SPA's `DeployStreamEvent`; emit it from `MockApi.deploy` | 4 |
| `packages/harness/web/src/lib/api.test.ts` | Modify: `linking` parses and stays non-terminal | 4 |
| `packages/harness/web/src/lib/use-harness-state.ts:941-943` | Modify: toast for the `linking` phase | 4 |
| `.changeset/deploy-auto-link.md` | **Create**: patch changeset | 5 |

---

### Task 1: Tell "unlinked" apart from "broken config"

`readDefinitionId` currently collapses both an unlinked project and an unparseable
`sapiom.json` into `null`. Task 2 needs those separated: auto-linking on a broken
config would create a remote agent and then die, because `writeConfig` calls
`readConfig`, which throws `BAD_CONFIG` on invalid JSON — leaving an orphaned
remote agent that nothing records. This task only splits the read and gives
bad-config its own message; the unlinked 409 still stands, and Task 2 removes it.

**Files:**
- Modify: `packages/harness/src/server/actions.ts:253-272` (the `readDefinitionId` helper) and `:401-407` (its call site)
- Test: `packages/harness/src/server/actions.test.ts:301-321` (the existing bad-config test)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  type ProjectConfigState =
    | { kind: "linked"; definitionId: string }
    | { kind: "unlinked"; name?: string }
    | { kind: "bad-config" };

  function readProjectConfigState(
    readConfig: typeof coreReadConfig,
    projectDir: string,
  ): ProjectConfigState;
  ```
  Task 2 consumes both. The `name` on `unlinked` is `sapiom.json`'s cached `name` — step 2 of Task 2's fallback chain.

- [ ] **Step 1: Strengthen the existing bad-config test to assert the message**

In `packages/harness/src/server/actions.test.ts`, find the test named
`"returns 409 when sapiom.json is unreadable/unparseable"` (around line 301). It
currently asserts only the status. Add the message assertion, so the two 409s are
distinguishable from the outside:

```ts
      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, {
        method: "POST",
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("sapiom.json is not valid JSON");
      expect(coreDeps.deploy).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @sapiom/harness exec vitest run src/server/actions.test.ts -t "unreadable/unparseable"
```

Expected: FAIL — received `"workflow is not linked to a Sapiom agent"`, expected
`"sapiom.json is not valid JSON"`.

- [ ] **Step 3: Replace the helper with the three-way read**

In `packages/harness/src/server/actions.ts`, replace the whole
`readDefinitionId` function (and its doc comment) with:

```ts
/**
 * What a project's `sapiom.json` says about its server-side identity. Three
 * states, not two: an unlinked project is fixable by linking on the spot (the
 * deploy route does exactly that), while an unparseable file is not — and
 * telling them apart matters, because `writeConfig` re-reads the file and
 * throws BAD_CONFIG on invalid JSON. Auto-linking on a broken config would
 * create a remote agent and then fail to record it, orphaning it.
 *
 * `name` on the unlinked state is the cached agent name a previous `link`
 * wrote, if any — the deploy route uses it to name the agent it creates.
 */
type ProjectConfigState =
  | { kind: "linked"; definitionId: string }
  | { kind: "unlinked"; name?: string }
  | { kind: "bad-config" };

function readProjectConfigState(
  readConfig: typeof coreReadConfig,
  projectDir: string,
): ProjectConfigState {
  let config: SapiomConfig | null;
  try {
    config = readConfig(projectDir);
  } catch {
    return { kind: "bad-config" };
  }
  const definitionId = config?.definitionId;
  if (definitionId) return { kind: "linked", definitionId };
  return config?.name ? { kind: "unlinked", name: config.name } : { kind: "unlinked" };
}
```

- [ ] **Step 4: Update the call site**

In the same file, replace these lines in the deploy route (currently `:401-407`):

```ts
    const definitionId = readDefinitionId(deps.readConfig, workflow.path);
    if (!definitionId) {
      res
        .status(409)
        .json({ error: "workflow is not linked to a Sapiom agent" });
      return;
    }
```

with:

```ts
    const configState = readProjectConfigState(deps.readConfig, workflow.path);
    if (configState.kind === "bad-config") {
      res.status(409).json({ error: "sapiom.json is not valid JSON" });
      return;
    }
    if (configState.kind === "unlinked") {
      res
        .status(409)
        .json({ error: "workflow is not linked to a Sapiom agent" });
      return;
    }
    const definitionId = configState.definitionId;
```

- [ ] **Step 5: Run the full actions suite**

```bash
pnpm --filter @sapiom/harness exec vitest run src/server/actions.test.ts
```

Expected: PASS, all tests. The unlinked-409 test still passes (Task 2 rewrites it).

- [ ] **Step 6: Commit**

```bash
git add packages/harness/src/server/actions.ts packages/harness/src/server/actions.test.ts
git commit -m "refactor(harness): tell an unlinked project apart from an unparseable sapiom.json"
```

---

### Task 2: Deploy links (or creates) the agent when the project isn't linked

The behaviour change. Note that **you are deleting a passing test's premise**:
`"returns 409 when the workflow has no linked definitionId"` asserts exactly the
bug we are fixing. Rewrite it as specified below — do not preserve the old
assertion, and do not weaken the new code to keep it green.

**Files:**
- Modify: `packages/harness/src/server/actions.ts` — `ActionWorkflow`, `DeployStreamEvent`, `ActionsCoreDeps`, `DEFAULT_CORE_DEPS`, `ActionsRouterOpts`, the deploy route body, the `node:path` import
- Test: `packages/harness/src/server/actions.test.ts` — `makeCoreDeps`, the rewritten test, five new tests

**Interfaces:**
- Consumes: `ProjectConfigState` / `readProjectConfigState` from Task 1.
- Produces:
  ```ts
  interface ActionWorkflow { path: string; name?: string }

  type DeployStreamEvent =
    | { phase: "linking"; name: string }
    | { phase: "building"; definitionId: string }
    | { phase: "ready"; definitionId: string; buildRunId: string; status: string }
    | { phase: "error"; code: string; message: string; hint?: string };

  interface ActionsCoreDeps {
    createClient: typeof createClient;
    deploy: typeof coreDeploy;
    run: typeof coreRun;
    readConfig: typeof coreReadConfig;
    link: typeof coreLink;         // new
    writeConfig: typeof coreWriteConfig;  // new
  }

  // on ActionsRouterOpts:
  resolveDefinitionName?: (workflow: ActionWorkflow) => Promise<string | null>;
  ```
  Task 3 implements `resolveDefinitionName`; Task 4 mirrors `DeployStreamEvent`.
  `name` on `ActionWorkflow` is **optional** — 30 existing test call sites build
  `{ path: "/proj/agent" }` literals, and a required field would break them all
  for no behavioural gain. The route falls back to `basename(path)`.

- [ ] **Step 1: Write the failing tests**

In `packages/harness/src/server/actions.test.ts`, first extend the fake-deps
factory so the two new deps exist on every test (find `makeCoreDeps`, around
line 26, and add the two entries before the `...overrides` spread):

```ts
    readConfig: vi.fn().mockReturnValue({ definitionId: "def_123" }),
    link: vi.fn().mockResolvedValue({ definitionId: "def_new", name: "order-triage" }),
    writeConfig: vi.fn(),
    ...overrides,
```

Then **replace** the test named `"returns 409 when the workflow has no linked
definitionId"` (around line 281) with these six tests:

```ts
    it("links (creating the agent) then deploys when the project is not linked yet", async () => {
      // A fresh gallery-template clone: sapiom.json carries the fork
      // provenance and no definitionId. This is the case that used to 409.
      const coreDeps = makeCoreDeps({
        readConfig: vi.fn().mockReturnValue({ forkId: "fork_7", templateId: "order-triage" }),
        link: vi.fn().mockResolvedValue({ definitionId: "def_new", name: "order-triage" }),
        deploy: vi.fn().mockResolvedValue({
          definitionId: "def_new",
          buildRunId: "build_1",
          status: "ready",
        }),
      });
      start({
        apiKey: "sk-test-key",
        resolveWorkflow: () => ({ path: "/proj/agent", name: "order-triage" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, { method: "POST" });
      expect(res.status).toBe(200);

      // The linking line precedes building, and the stream still ends with
      // exactly one terminal line.
      expect(parseNdjson(await res.text())).toEqual([
        { phase: "linking", name: "order-triage" },
        { phase: "building", definitionId: "def_new" },
        { phase: "ready", definitionId: "def_new", buildRunId: "build_1", status: "ready" },
      ]);

      // create: true is what makes this work on an agent that does not exist
      // remotely yet; link() itself matches an existing one by name/slug first.
      expect(coreDeps.link).toHaveBeenCalledWith(
        { name: "order-triage", create: true },
        expect.anything(),
      );
      // The id is cached under the name the SERVER returned, and writeConfig
      // merges, so the clone's forkId/templateId survive.
      expect(coreDeps.writeConfig).toHaveBeenCalledWith("/proj/agent", {
        definitionId: "def_new",
        name: "order-triage",
      });
      // The build then runs against the freshly linked id.
      expect(coreDeps.deploy).toHaveBeenCalledWith(
        { projectDir: "/proj/agent", definitionId: "def_new" },
        expect.anything(),
      );
    });

    it("does not link when the project is already linked", async () => {
      // Regression guard for the common path: a linked project must never pay
      // for a definitions round-trip, and its stream shape is unchanged.
      const coreDeps = makeCoreDeps({
        deploy: vi.fn().mockResolvedValue({
          definitionId: "def_123",
          buildRunId: "build_9",
          status: "ready",
        }),
      });
      start({
        apiKey: "sk-test-key",
        resolveWorkflow: () => ({ path: "/proj/agent" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, { method: "POST" });
      const events = parseNdjson(await res.text());

      expect(coreDeps.link).not.toHaveBeenCalled();
      expect(coreDeps.writeConfig).not.toHaveBeenCalled();
      expect(events[0]).toEqual({ phase: "building", definitionId: "def_123" });
    });

    it("ends the stream with one terminal error when linking fails, without building", async () => {
      const { AgentOperationError } = await import("@sapiom/agent-core");
      const coreDeps = makeCoreDeps({
        readConfig: vi.fn().mockReturnValue({}),
        link: vi.fn().mockRejectedValue(
          new AgentOperationError({
            code: "HTTP_404",
            message: "Could not create the agent.",
            hint: "The tenant deploy routes may not be enabled.",
          }),
        ),
      });
      start({
        apiKey: "sk-test-key",
        resolveWorkflow: () => ({ path: "/proj/agent", name: "agent" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, { method: "POST" });
      expect(res.status).toBe(200);

      // A link failure is reported as itself — never disguised as a build
      // failure — and nothing is written or built.
      expect(parseNdjson(await res.text())).toEqual([
        { phase: "linking", name: "agent" },
        {
          phase: "error",
          code: "HTTP_404",
          message: "Could not create the agent.",
          hint: "The tenant deploy routes may not be enabled.",
        },
      ]);
      expect(coreDeps.deploy).not.toHaveBeenCalled();
      expect(coreDeps.writeConfig).not.toHaveBeenCalled();
    });

    it("refreshes the key once and retries when linking is rejected as unauthorized", async () => {
      const coreDeps = makeCoreDeps({
        readConfig: vi.fn().mockReturnValue({}),
        link: vi
          .fn()
          .mockRejectedValueOnce(await makeAuthRejection(401))
          .mockResolvedValue({ definitionId: "def_new", name: "agent" }),
        deploy: vi.fn().mockResolvedValue({
          definitionId: "def_new",
          buildRunId: "build_1",
          status: "ready",
        }),
      });
      const provider = refreshingProvider("sk-stale", "sk-fresh");
      start({
        apiKey: provider,
        resolveWorkflow: () => ({ path: "/proj/agent", name: "agent" }),
        coreDeps,
      });

      const res = await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, { method: "POST" });
      const events = parseNdjson(await res.text());

      expect(provider.refreshCalls).toBe(1);
      expect(coreDeps.link).toHaveBeenCalledTimes(2);
      // The retry is transparent: no extra linking line, normal terminal.
      expect(events.filter((e) => e.phase === "linking")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ phase: "ready", definitionId: "def_new" });
    });

    it("names the created agent from the resolveDefinitionName seam when it resolves", async () => {
      // The seam supplies the agent's declared manifest name, which wins over
      // both sapiom.json's cached name and the registry name.
      const coreDeps = makeCoreDeps({
        readConfig: vi.fn().mockReturnValue({ name: "cached-name" }),
        deploy: vi.fn().mockResolvedValue({
          definitionId: "def_new",
          buildRunId: "b",
          status: "ready",
        }),
      });
      start({
        apiKey: "sk-test-key",
        resolveWorkflow: () => ({ path: "/proj/agent", name: "registry-name" }),
        resolveDefinitionName: () => Promise.resolve("manifest-name"),
        coreDeps,
      });

      await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, { method: "POST" });

      expect(coreDeps.link).toHaveBeenCalledWith(
        { name: "manifest-name", create: true },
        expect.anything(),
      );
    });

    it("falls back to the cached name, then the registry name, then the folder", async () => {
      // The seam is absent or fails (no node_modules yet, a bundle error) —
      // each fallback in turn must still yield a usable name.
      const cases: Array<{
        config: Record<string, unknown>;
        workflow: { path: string; name?: string };
        seam?: () => Promise<string | null>;
        expected: string;
      }> = [
        // Seam rejects → sapiom.json's cached name.
        {
          config: { name: "cached-name" },
          workflow: { path: "/proj/agent", name: "registry-name" },
          seam: () => Promise.reject(new Error("no node_modules")),
          expected: "cached-name",
        },
        // No seam, no cached name → the registry name.
        {
          config: {},
          workflow: { path: "/proj/agent", name: "registry-name" },
          expected: "registry-name",
        },
        // Nothing at all → the project folder's basename.
        {
          config: {},
          workflow: { path: "/proj/my-agent" },
          seam: () => Promise.resolve(null),
          expected: "my-agent",
        },
      ];

      for (const testCase of cases) {
        const coreDeps = makeCoreDeps({
          readConfig: vi.fn().mockReturnValue(testCase.config),
          deploy: vi.fn().mockResolvedValue({
            definitionId: "def_new",
            buildRunId: "b",
            status: "ready",
          }),
        });
        start({
          apiKey: "sk-test-key",
          resolveWorkflow: () => testCase.workflow,
          ...(testCase.seam ? { resolveDefinitionName: testCase.seam } : {}),
          coreDeps,
        });

        await fetch(`${baseUrl}/api/workflows/wf-1/deploy`, { method: "POST" });

        expect(coreDeps.link).toHaveBeenCalledWith(
          { name: testCase.expected, create: true },
          expect.anything(),
        );
        // Each iteration starts its own server; close it before the next.
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
```

Note on the last test: `start()` assigns the suite-level `server`, and `afterEach`
closes it — closing an already-closed server would throw, so the loop closes each
iteration's server itself and the final one is left for `afterEach`. If that
proves awkward in practice, split the loop into three separate `it()` blocks
rather than weakening the assertions.

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @sapiom/harness exec vitest run src/server/actions.test.ts
```

Expected: FAIL. The new tests fail on the 409 (no `linking` line, `link` never
called); TypeScript also reports `resolveDefinitionName` and `name` as unknown
properties. Both are the point.

- [ ] **Step 3: Import the new core ops and `basename`**

In `packages/harness/src/server/actions.ts`, extend the two existing imports.
`node:path` (line 29) becomes:

```ts
import { basename, dirname, join } from "node:path";
```

and the `@sapiom/agent-core` import block (lines 33-42) gains three entries:

```ts
import {
  AgentOperationError,
  createClient,
  deploy as coreDeploy,
  link as coreLink,
  run as coreRun,
  readConfig as coreReadConfig,
  writeConfig as coreWriteConfig,
  type DeployResult,
  type LinkResult,
  type RunResult,
  type SapiomConfig,
} from "@sapiom/agent-core";
```

- [ ] **Step 4: Widen the types**

Add `name` to `ActionWorkflow` (line 57):

```ts
export interface ActionWorkflow {
  /** Absolute path to the agent project directory (deploy's `projectDir`). */
  path: string;
  /**
   * Registry display name (`package.json`'s `name`, else the folder basename).
   * Optional so a host that only knows the path still works; used as a
   * mid-priority fallback when naming an agent this route has to create.
   */
  name?: string;
}
```

Add the `linking` member to `DeployStreamEvent` and refresh its doc comment
(lines 63-72):

```ts
/**
 * One line of the deploy NDJSON stream. `linking` is emitted only when the
 * project had no `definitionId` and the route is resolving-or-creating its
 * remote agent; `building` is emitted once the build is triggered; exactly one
 * terminal line (`ready` | `error`) closes the stream. `capability`-agnostic
 * and credential-free by construction.
 */
export type DeployStreamEvent =
  | { phase: "linking"; name: string }
  | { phase: "building"; definitionId: string }
  | { phase: "ready"; definitionId: string; buildRunId: string; status: string }
  | { phase: "error"; code: string; message: string; hint?: string };
```

Add the two deps to `ActionsCoreDeps` and `DEFAULT_CORE_DEPS` (lines 78-90):

```ts
export interface ActionsCoreDeps {
  createClient: typeof createClient;
  deploy: typeof coreDeploy;
  run: typeof coreRun;
  readConfig: typeof coreReadConfig;
  /** Resolve-or-create the server-side agent for an unlinked project. */
  link: typeof coreLink;
  /** Cache the linked id back into `sapiom.json` (merges; never clobbers). */
  writeConfig: typeof coreWriteConfig;
}

const DEFAULT_CORE_DEPS: ActionsCoreDeps = {
  createClient,
  deploy: coreDeploy,
  run: coreRun,
  readConfig: coreReadConfig,
  link: coreLink,
  writeConfig: coreWriteConfig,
};
```

- [ ] **Step 5: Add the name seam to the router options**

In `ActionsRouterOpts`, directly after the `resolveWorkflow` field
(currently ending at line 241), add:

```ts
  /**
   * The agent's DECLARED name (`defineAgent({ name })`) for a project the route
   * has to link on the fly, or null when it cannot be determined. Optional: the
   * route falls back to `sapiom.json`'s cached name, then
   * {@link ActionWorkflow.name}, then the project folder's basename.
   *
   * A seam rather than a direct call so this router keeps knowing nothing about
   * the canvas extraction cache (see core/definition-name.ts, which
   * `server/index.ts` wires in here). Never expected to throw — a rejection is
   * treated as "could not determine".
   */
  resolveDefinitionName?: (workflow: ActionWorkflow) => Promise<string | null>;
```

- [ ] **Step 6: Implement the auto-link branch in the route**

Two edits in the deploy route.

First, replace Task 1's whole config block — keeping the bad-config 409, dropping
the unlinked 409 so that case falls through, **and deleting the
`const definitionId = configState.definitionId;` line** (it must go: `configState`
is no longer narrowed to `linked` here, so that line would not compile, and the
id is now produced by `ensureDefinitionId` below). The block becomes exactly:

```ts
    const configState = readProjectConfigState(deps.readConfig, workflow.path);
    if (configState.kind === "bad-config") {
      res.status(409).json({ error: "sapiom.json is not valid JSON" });
      return;
    }
```

Second, replace everything from `write({ phase: "building", definitionId });`
through the end of the `try/catch/finally` (currently lines 418-440) with:

```ts
    /**
     * The definition id to build against: the linked one, or a freshly
     * resolved-or-created one for a project that has never been linked (a
     * gallery-template clone lands exactly this way — `clone` writes the fork
     * provenance and leaves `definitionId` for deploy to fill in).
     *
     * `link({ create: true })` matches an existing remote agent by name/slug
     * BEFORE creating one, so this is resync-or-create: re-deploying never
     * duplicates an agent, and a template already deployed from another machine
     * re-attaches to the same definition.
     */
    const ensureDefinitionId = async (): Promise<string> => {
      if (configState.kind === "linked") return configState.definitionId;

      const fromSeam = opts.resolveDefinitionName
        ? await opts.resolveDefinitionName(workflow).catch(() => null)
        : null;
      const name =
        fromSeam?.trim() ||
        configState.name?.trim() ||
        workflow.name?.trim() ||
        basename(workflow.path);

      write({ phase: "linking", name });
      // Same refresh-on-rejected-key recovery the build gets; the retry is
      // transparent to the stream (no second linking line).
      const linked: LinkResult = await withKeyRefreshRetry(
        provider,
        clientFor,
        (client) => deps.link({ name, create: true }, client),
      );
      // Cache under the name the SERVER settled on, matching what
      // `sapiom agents link` writes. writeConfig merges, so the clone's
      // forkId/templateId/repoFullName survive.
      deps.writeConfig(workflow.path, {
        definitionId: linked.definitionId,
        name: linked.name,
      });
      return linked.definitionId;
    };

    try {
      // A link failure throws out of here and is mapped by the same
      // toDeployErrorEvent below — reported as itself, never as a build
      // failure, and `deploy` is never reached.
      const definitionId = await ensureDefinitionId();
      write({ phase: "building", definitionId });
      // Auth against the live key, refreshing + retrying once on a rejected key
      // (same recovery the runs router gets). The building/terminal streaming
      // shape is unchanged — the retry is transparent to the NDJSON stream.
      const result: DeployResult = await withKeyRefreshRetry(
        provider,
        clientFor,
        (client) =>
          deps.deploy({ projectDir: workflow.path, definitionId }, client),
      );
      write({
        phase: "ready",
        definitionId: result.definitionId,
        buildRunId: result.buildRunId,
        status: result.status,
      });
    } catch (err) {
      write(toDeployErrorEvent(err));
    } finally {
      res.end();
    }
```

Also update the route's JSDoc (lines 369-383): the `409` line now reads
`409  sapiom.json is unparseable`, and add a sentence saying an unlinked project
is linked on the fly (`linking` line) rather than rejected.

- [ ] **Step 7: Run the tests until green**

```bash
pnpm --filter @sapiom/harness exec vitest run src/server/actions.test.ts
```

Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 8: Typecheck**

```bash
pnpm --filter @sapiom/harness exec tsc --noEmit
```

Expected: no errors. (`server/index.ts` still compiles — the new option is
optional; Task 3 wires it.)

- [ ] **Step 9: Commit**

```bash
git add packages/harness/src/server/actions.ts packages/harness/src/server/actions.test.ts
git commit -m "feat(harness): deploy links or creates the remote agent when the project isn't linked"
```

---

### Task 3: Name the created agent after its declared manifest name

Without this, an agent created from a clone is named after the folder it landed
in. `graph.manifestName` is the agent's own `defineAgent({ name })` — the value
this codebase already treats as authoritative (the registry stores it as
`definitionSlug`; `sapiom.json`'s `name` is documented as a cache of it). It is
usually free: the canvas renders on bind, so the extraction is already cached.

**Files:**
- Create: `packages/harness/src/core/definition-name.ts`
- Create: `packages/harness/src/core/definition-name.test.ts`
- Modify: `packages/harness/src/server/index.ts:1166-1177`

**Interfaces:**
- Consumes: `ActionsRouterOpts.resolveDefinitionName` from Task 2.
- Produces:
  ```ts
  function resolveManifestName(
    projectDir: string,
    extract?: typeof extractWorkflowGraphCached,
  ): Promise<string | null>;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/harness/src/core/definition-name.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { resolveManifestName } from "./definition-name.js";

/** A cached-extraction result shaped like canvas-cache's, with just the field
 *  under test populated. */
function extraction(manifestName: string) {
  return {
    result: {
      ok: true as const,
      graph: {
        manifestName,
        entry: "start",
        nodes: [],
        edges: [],
        warnings: [],
      },
    },
    cached: true,
    fingerprint: "1:1",
  };
}

describe("resolveManifestName", () => {
  it("returns the agent's declared manifest name", async () => {
    const extract = vi.fn().mockResolvedValue(extraction("order-triage"));
    await expect(resolveManifestName("/proj/agent", extract)).resolves.toBe("order-triage");
    expect(extract).toHaveBeenCalledWith("/proj/agent");
  });

  it("returns null when extraction failed", async () => {
    // The usual cause: node_modules isn't installed yet, so the check process
    // cannot bundle. The caller falls back to another name source.
    const extract = vi.fn().mockResolvedValue({
      result: { ok: false as const, reason: "run npm install first" },
      cached: false,
      fingerprint: "0:0",
    });
    await expect(resolveManifestName("/proj/agent", extract)).resolves.toBeNull();
  });

  it("returns null when extraction throws", async () => {
    const extract = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(resolveManifestName("/proj/agent", extract)).resolves.toBeNull();
  });

  it("returns null for a blank manifest name", async () => {
    const extract = vi.fn().mockResolvedValue(extraction("   "));
    await expect(resolveManifestName("/proj/agent", extract)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @sapiom/harness exec vitest run src/core/definition-name.test.ts
```

Expected: FAIL — cannot resolve `./definition-name.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/harness/src/core/definition-name.ts`:

```ts
/**
 * The name to give a server-side agent the deploy route has to create for a
 * project that was never linked (a gallery-template clone).
 *
 * The honest answer is the agent's own `defineAgent({ name })`, which the
 * canvas extraction already surfaces as `graph.manifestName` — and which the
 * registry stores as `definitionSlug` and `sapiom.json` caches as `name`. Read
 * through the fingerprint cache (core/canvas-cache.ts), so this is normally
 * free: the canvas renders on bind, so the extraction is already warm.
 *
 * Never throws and never blocks a deploy: any failure (no `node_modules` yet,
 * a bundle error, the check process timing out) comes back as null and the
 * caller falls back to a weaker name source.
 */
import { extractWorkflowGraphCached } from "./canvas-cache.js";

export async function resolveManifestName(
  projectDir: string,
  extract: typeof extractWorkflowGraphCached = extractWorkflowGraphCached,
): Promise<string | null> {
  try {
    const { result } = await extract(projectDir);
    if (!result.ok) return null;
    return result.graph.manifestName.trim() || null;
  } catch {
    // Extraction is best-effort here — a name is a nicety, a deploy is not.
    return null;
  }
}
```

- [ ] **Step 4: Run the test**

```bash
pnpm --filter @sapiom/harness exec vitest run src/core/definition-name.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Wire it into the server**

In `packages/harness/src/server/index.ts`, add the import next to the other
`../core/*` imports:

```ts
import { resolveManifestName } from "../core/definition-name.js";
```

Then extend the `createActionsRouter` call (currently lines 1166-1177) so the
router also gets the registry name and the seam:

```ts
  app.use(
    createActionsRouter({
      // Pass the provider (not a static key) so deploy/prod-run authenticate
      // with the live key and can refresh + retry on a rejected key, recovering
      // instead of locking — matching the runs router above.
      apiKey: apiKeyProvider,
      // coreBaseUrl omitted: the router self-defaults via resolveCoreBaseUrl()
      // (see actions.ts), which derives the core host from the agents env.
      resolveWorkflow: (id) => {
        const workflow = workflowsCache.find((w) => w.path === id);
        // `name` is the registry's display name — a fallback for naming an
        // agent the deploy route has to create.
        return workflow ? { path: workflow.path, name: workflow.name } : null;
      },
      // Prefer the agent's DECLARED name when deploy has to create it, read
      // from the same warm extraction cache the canvas renders from.
      resolveDefinitionName: (workflow) => resolveManifestName(workflow.path),
    }),
  );
```

- [ ] **Step 6: Typecheck and run the server suite**

```bash
pnpm --filter @sapiom/harness exec tsc --noEmit
pnpm --filter @sapiom/harness exec vitest run src/server src/core/definition-name.test.ts
```

Expected: no type errors; all tests pass.

Note: this step's wiring is covered by types plus Task 2's seam-precedence tests
rather than by a test of its own — asserting it end-to-end would need a real
project with installed `node_modules` and an esbuild run. If you can do that
cheaply in this repo (e.g. against the bundled example project), adding it is
welcome; do not fake it with a test that asserts nothing.

- [ ] **Step 7: Commit**

```bash
git add packages/harness/src/core/definition-name.ts packages/harness/src/core/definition-name.test.ts packages/harness/src/server/index.ts
git commit -m "feat(harness): name an auto-created agent after its declared manifest name"
```

---

### Task 4: The SPA reports the linking step

The server can now emit a phase the browser's type union does not know about.
Mirror it, give it a toast, and teach the mock API to emit it so mock mode and
real mode behave alike (the mock's own comment already promises to "mirror the
real server" on this).

**Files:**
- Modify: `packages/harness/web/src/lib/api.ts:80-88` (the mirrored union) and `:1160-1198` (`MockApi.deploy`)
- Modify: `packages/harness/web/src/lib/use-harness-state.ts:941-943`
- Test: `packages/harness/web/src/lib/api.test.ts`

**Interfaces:**
- Consumes: `DeployStreamEvent`'s `linking` member from Task 2.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing tests**

Append to `packages/harness/web/src/lib/api.test.ts`, inside the existing
`describe("terminalDeployEvent")` block:

```ts
  it("treats a linking line as non-terminal", async () => {
    // The server emits `linking` before `building` when it has to create the
    // agent; only ready/error may end the stream.
    const events: DeployStreamEvent[] = [
      { phase: "linking", name: "order-triage" },
      { phase: "building", definitionId: "42" },
    ];
    expect(terminalDeployEvent(events)).toMatchObject({ phase: "error", code: "NO_OUTPUT" });
  });
```

and add a new top-level describe block:

```ts
describe("parseNdjsonLine of a linking event", () => {
  it("parses the linking phase and its name", () => {
    expect(parseNdjsonLine<DeployStreamEvent>('{"phase":"linking","name":"order-triage"}')).toEqual({
      phase: "linking",
      name: "order-triage",
    });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @sapiom/harness exec vitest run web/src/lib/api.test.ts
```

Expected: FAIL — TypeScript rejects `{ phase: "linking", … }`, which is not
assignable to the SPA's `DeployStreamEvent`.

- [ ] **Step 3: Mirror the union member**

In `packages/harness/web/src/lib/api.ts`, replace the `DeployStreamEvent`
declaration and its doc comment (lines 80-88) with:

```ts
/**
 * One line of the `POST /api/workflows/:id/deploy` NDJSON stream (mirrors
 * `DeployStreamEvent` in src/server/actions.ts): an optional `linking` line
 * when the server has to resolve-or-create the remote agent first, a `building`
 * line, then exactly one terminal `ready` | `error` line closing the stream.
 */
export type DeployStreamEvent =
  | { phase: "linking"; name: string }
  | { phase: "building"; definitionId: string }
  | { phase: "ready"; definitionId: string; buildRunId: string; status: string }
  | { phase: "error"; code: string; message: string; hint?: string };
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @sapiom/harness exec vitest run web/src/lib/api.test.ts
```

Expected: PASS.

- [ ] **Step 5: Toast the linking phase**

In `packages/harness/web/src/lib/use-harness-state.ts`, replace the `onEvent`
handler inside `deploy` (line 942):

```ts
        const terminal = await api.deploy(workflowPath, (event) => {
          // A never-linked project (a fresh template clone) gets its agent
          // created first — say so, rather than claiming we're building.
          if (event.phase === "linking") {
            setToast(`Deploying — creating the agent "${event.name}" on Sapiom…`);
          } else if (event.phase === "building") {
            setToast("Deploying — building on Sapiom…");
          }
        });
```

- [ ] **Step 6: Teach the mock API to emit it**

In `packages/harness/web/src/lib/api.ts`, in `MockApi.deploy`, insert before the
existing `building` line (line 1166):

```ts
    this.recordDirectAction("deploy", { workflowPath });
    // Mirror the real server: an unlinked workflow is linked (agent created)
    // before the build, so mock mode exercises the same two-phase stream.
    const target = this.workflows.find((w) => w.path === workflowPath);
    if (target && target.definitionId == null) {
      const linking: DeployStreamEvent = { phase: "linking", name: target.name };
      onEvent?.(linking);
      await delay(200);
    }
    const building: DeployStreamEvent = { phase: "building", definitionId: "mock-def" };
```

- [ ] **Step 7: Run the whole web suite plus a typecheck**

```bash
pnpm --filter @sapiom/harness exec vitest run web/src
pnpm --filter @sapiom/harness exec tsc --noEmit -p web/tsconfig.json
```

Expected: all pass, no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/harness/web/src/lib/api.ts packages/harness/web/src/lib/api.test.ts packages/harness/web/src/lib/use-harness-state.ts
git commit -m "feat(harness): surface the linking step in the deploy stream UI"
```

---

### Task 5: Changeset and full verification

**Files:**
- Create: `.changeset/deploy-auto-link.md`

**Interfaces:**
- Consumes: everything above. Produces: nothing.

- [ ] **Step 1: Write the changeset**

Create `.changeset/deploy-auto-link.md`:

```markdown
---
"@sapiom/harness": patch
---

Deploy now links (or creates) the remote agent for a project that has never been
linked, instead of failing.

A gallery-template clone lands with `sapiom.json` carrying its fork provenance
and no `definitionId` — by design, since the definition was always meant to be
created at deploy. That half was missing, so `POST /api/workflows/:id/deploy`
answered 409 "workflow is not linked to a Sapiom agent" and the Deploy button
could not succeed on a fresh template.

The route now resolves-or-creates the agent first (`link({ create: true })`,
which matches an existing definition by name/slug before creating one, so
re-deploying never duplicates it), caches the id in `sapiom.json`, and continues
into the build. The stream gains a non-terminal `linking` line so the UI can say
what it is doing; terminal lines are unchanged. An unparseable `sapiom.json`
still 409s — now with a message that says so, because creating a remote agent we
could not record would orphan it.
```

- [ ] **Step 2: Run the full harness suite**

```bash
pnpm --filter @sapiom/harness test
```

Expected: PASS. Baseline was 102 files / 1578 tests; you should now have ~1590
(the tests added here, minus the one rewritten in Task 2).

- [ ] **Step 3: Lint and typecheck both projects**

```bash
pnpm --filter @sapiom/harness lint
pnpm --filter @sapiom/harness typecheck
```

Expected: clean.

- [ ] **Step 4: Build, to prove the desktop host still consumes this**

```bash
pnpm --filter @sapiom/harness build
```

Expected: exit 0. (`harness-desktop` builds from this `dist/`.)

- [ ] **Step 5: Commit**

```bash
git add .changeset/deploy-auto-link.md
git commit -m "docs: changeset for deploy auto-link"
```

---

## Verification Notes for the Reviewer

Two things this plan deliberately does **not** claim:

1. **The backend `POST /definitions` route may not exist.**
   `packages/cli/src/commands/agents/link.ts:12` records that the `--create`
   path depended on tenant deploy routes added in a parallel effort. If that
   route is not live, the user now sees a named failure with a hint
   (`HTTP_404` + "Could not create the agent") instead of an opaque 409 — an
   improvement, but not a working button. Confirm against a real tenant before
   calling the feature done; the unit tests cover our side of the contract only.

2. **`server/index.ts`'s seam wiring has no test of its own** (Task 3, Step 6).
   Its correctness rests on the type system plus Task 2's seam-precedence tests.

Out of scope, per the spec: `sapiom agents init` writes no `sapiom.json`, so a
scaffolded (non-gallery) project is never discovered by the registry and never
gets a Deploy button to click. Separate bug, separate fix.
