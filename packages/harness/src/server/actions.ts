/**
 * Actions router — backs the direct, in-app agent action macros:
 *   POST /api/workflows/:id/deploy  → deploy the linked agent (build + poll).
 *   POST /api/runs                  → start a prod execution → { executionId }.
 *
 * These are the "direct" replacements for the old CLI/agent-driven macros: the
 * harness server calls the Sapiom backend itself (via {@link deploy} / {@link run}
 * from @sapiom/agent-core), so an action never spawns Claude Code and never
 * consumes the user's LLM credits. The Sapiom API key is held server-side and
 * never forwarded to the browser — exactly like {@link createRunsRouter}: the
 * SPA hits these local `/api/*` routes (no key in the request) and the router
 * presents the key to the backend on its behalf.
 *
 * Deploy streams its build lifecycle as NDJSON (one JSON object per line, the
 * same line-oriented convention the local-run stream uses) so the canvas can
 * show "building…" the moment the build kicks off and a terminal line when it
 * settles. Prod-run is a single request/response returning `{ executionId }`,
 * which the existing live-canvas path then polls via the runs router.
 */

import { Router } from "express";
import {
  AgentOperationError,
  createClient,
  deploy as coreDeploy,
  run as coreRun,
  readConfig as coreReadConfig,
  type DeployResult,
  type RunResult,
  type SapiomConfig,
} from "@sapiom/agent-core";

import { resolveCoreBaseUrl } from "../core/definition-slug-resolver.js";

/**
 * A registered workflow the actions router can act on — the subset of
 * {@link WorkflowInfo} deploy needs. Resolved by the injected
 * {@link ActionsRouterOpts.resolveWorkflow} so the router stays decoupled from
 * the registry (mirrors the rest router's `findWorkflow` seam).
 */
export interface ActionWorkflow {
  /** Absolute path to the agent project directory (deploy's `projectDir`). */
  path: string;
}

/**
 * One line of the deploy NDJSON stream. `building` is emitted once the build is
 * triggered; exactly one terminal line (`ready` | `error`) closes the stream.
 * `capability`-agnostic and credential-free by construction.
 */
export type DeployStreamEvent =
  | { phase: "building"; definitionId: string }
  | { phase: "ready"; definitionId: string; buildRunId: string; status: string }
  | { phase: "error"; code: string; message: string; hint?: string };

/**
 * Injectable core operations. Real implementations are the @sapiom/agent-core
 * exports; tests substitute fakes so no route ever touches git or the network.
 * Undocumented for prod — a test seam only, mirroring `fetchImpl` in runs.ts.
 */
export interface ActionsCoreDeps {
  createClient: typeof createClient;
  deploy: typeof coreDeploy;
  run: typeof coreRun;
  readConfig: typeof coreReadConfig;
}

const DEFAULT_CORE_DEPS: ActionsCoreDeps = {
  createClient,
  deploy: coreDeploy,
  run: coreRun,
  readConfig: coreReadConfig,
};

export interface ActionsRouterOpts {
  /** Sapiom API key for the workflows surface; null when unauthenticated. */
  apiKey: string | null;
  /**
   * Backend host for @sapiom/agent-core's GatewayClient (the CORE surface —
   * `/v1/workflows` is appended by the client). Resolved from env by default.
   * Test seam.
   */
  coreBaseUrl?: string;
  /**
   * Resolve a workflow `:id` (as it appears in the route path) to the registered
   * workflow, or null when unknown. The caller supplies this from the live
   * registry — the router does not read the registry directly.
   */
  resolveWorkflow: (id: string) => ActionWorkflow | null;
  /** Injectable core operations. Test seam; defaults to the real exports. */
  coreDeps?: Partial<ActionsCoreDeps>;
}

/**
 * Extract the linked `definitionId` from a project's `sapiom.json`. The config
 * file — not the registry — is the source of truth for a project's server-side
 * definition id, so both deploy and (a future) resolve path read it here. Never
 * throws: an unlinked/unreadable project returns null and the route maps that to
 * a 409.
 */
function readDefinitionId(
  readConfig: typeof coreReadConfig,
  projectDir: string,
): string | null {
  let config: SapiomConfig | null;
  try {
    config = readConfig(projectDir);
  } catch {
    // BAD_CONFIG (unparseable sapiom.json) — treat as "not linked" for the route.
    return null;
  }
  return config?.definitionId ?? null;
}

/**
 * Map an {@link AgentOperationError} (or any thrown value) to a terminal deploy
 * stream event — the credential hint is dropped, only the machine code/message
 * survive (no key material, no provider names).
 */
function toDeployErrorEvent(
  err: unknown,
): Extract<DeployStreamEvent, { phase: "error" }> {
  if (err instanceof AgentOperationError) {
    return {
      phase: "error",
      code: err.code,
      message: err.message,
      ...(err.hint ? { hint: err.hint } : {}),
    };
  }
  return {
    phase: "error",
    code: "UNKNOWN",
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Create the actions router. Mounts:
 *   - `POST /api/workflows/:id/deploy` — NDJSON build-status stream.
 *   - `POST /api/runs` — `{ executionId }` for a started prod execution.
 *
 * Both run server-side with the held API key and never involve Claude Code.
 */
export function createActionsRouter(opts: ActionsRouterOpts): Router {
  const router = Router();
  const deps: ActionsCoreDeps = { ...DEFAULT_CORE_DEPS, ...opts.coreDeps };
  const baseUrl = opts.coreBaseUrl ?? resolveCoreBaseUrl();

  /**
   * POST /api/workflows/:id/deploy
   *
   * Deploys the linked agent for the given workflow id: mints push credentials,
   * pushes the synthesized tree, triggers a build, and polls to a terminal
   * status — all inside @sapiom/agent-core's {@link deploy}. Streams NDJSON: a
   * `building` line up front, then exactly one terminal `ready`/`error` line.
   *
   * 200  NDJSON stream (even a build failure is a 200 with a terminal `error`
   *      line — the request itself succeeded; the build outcome is in-band).
   * 400  id missing/empty
   * 404  workflow id not registered
   * 409  workflow is not linked to a Sapiom agent (no definitionId)
   * 503  harness is not signed in to Sapiom
   */
  router.post("/api/workflows/:id/deploy", async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string" || id.trim() === "") {
      res.status(400).json({ error: "workflow id is required" });
      return;
    }
    if (!opts.apiKey) {
      res.status(503).json({ error: "harness is not signed in to Sapiom" });
      return;
    }

    const workflow = opts.resolveWorkflow(id);
    if (!workflow) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }

    const definitionId = readDefinitionId(deps.readConfig, workflow.path);
    if (!definitionId) {
      res
        .status(409)
        .json({ error: "workflow is not linked to a Sapiom agent" });
      return;
    }

    // From here the outcome is streamed in-band as NDJSON — status is 200 and
    // headers are committed before the (potentially long) build runs.
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const write = (event: DeployStreamEvent): void => {
      res.write(JSON.stringify(event) + "\n");
    };

    write({ phase: "building", definitionId });

    try {
      const client = deps.createClient({ host: baseUrl, apiKey: opts.apiKey });
      const result: DeployResult = await deps.deploy(
        { projectDir: workflow.path, definitionId },
        client,
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
  });

  /**
   * POST /api/runs  { definitionId, input }
   *
   * Starts a prod execution of the given definition and returns
   * `{ executionId }` — the live-canvas path then polls the runs router for its
   * per-step state. `input` is optional (defaults to an empty object for
   * no-input agents). The key stays server-side.
   *
   * 200  { executionId } — execution created
   * 400  definitionId missing/empty
   * 502  gateway error (network or non-2xx from the backend)
   * 503  harness is not signed in to Sapiom
   */
  router.post("/api/runs", async (req, res) => {
    if (!opts.apiKey) {
      res.status(503).json({ error: "harness is not signed in to Sapiom" });
      return;
    }

    const body = (req.body ?? {}) as {
      definitionId?: unknown;
      input?: unknown;
    };
    const definitionId = body.definitionId;
    if (typeof definitionId !== "string" || definitionId.trim() === "") {
      res.status(400).json({ error: "definitionId is required" });
      return;
    }

    try {
      const client = deps.createClient({ host: baseUrl, apiKey: opts.apiKey });
      const result: RunResult = await deps.run(
        { definitionId, input: body.input },
        client,
      );
      res.json({ executionId: result.executionId });
    } catch (err) {
      if (err instanceof AgentOperationError) {
        // The gateway/network failed — surface a 502 with the machine code, no
        // credential hint (that hint names the login flow, not for the browser).
        res.status(502).json({ error: err.message, code: err.code });
      } else {
        res
          .status(502)
          .json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  return router;
}
