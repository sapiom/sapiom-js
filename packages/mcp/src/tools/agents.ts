/**
 * Agent authoring tools. Thin wrappers over @sapiom/agent-core.
 * Local tools (scaffold / check / run_local) need no Sapiom account or real
 * capability calls; scaffold may query npm for current dependency versions.
 * Networked tools (link / deploy / run / inspect / signal) build a client from
 * the cached credential and the environment's API host.
 *
 * Results are returned as JSON text so the calling agent can parse them. In
 * particular, `run_local` returns a per-step trace plus `unusedStubs` /
 * `stubWarnings` that flag supplied stubs which didn't take effect.
 */
import { createRequire } from "node:module";
import path from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  cancelSchedule,
  check,
  clone,
  completeScheduleSecretRotation,
  createSchedule,
  deploy,
  getSchedule,
  inspect,
  inspectBuild,
  isExecutionTerminal,
  link,
  listExecutions,
  listSchedules,
  AgentOperationError,
  parseStubFile,
  previewCron,
  requireConfig,
  revokeScheduleSecret,
  rotateScheduleSecret,
  run,
  runLocalFromDir,
  scaffold,
  signal,
  waitForExecution,
  writeConfig,
  type CreateScheduleResult,
  type ScheduleDetail,
  type SchedulePolicy,
  type StubFile,
} from "@sapiom/agent-core";
import { type ResolvedEnvironment } from "../credentials.js";
import { registerTool } from "../register-tool.js";
import {
  INCLUDABLE_FIELDS,
  projectExecutionForTool,
  type ProjectExecutionOptions,
} from "./execution-projection.js";
import { fail, gatewayClient, NOT_AUTHED, ok } from "./shared.js";
import { webappRunUrl } from "./webapp-url.js";

/**
 * Coerce a tool argument that may arrive as a JSON string (some MCP clients
 * serialize object-valued args) back into a value. A non-JSON string is
 * returned as-is (a legitimately string-valued input).
 */
function coerceJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const nodeRequire = createRequire(import.meta.url);

/**
 * Locate the bundled templates directory of @sapiom/agent-core. This
 * ESM server has no `__dirname`, so the templates dir is resolved from the
 * package's entry and passed to `scaffold` explicitly.
 */
function coreTemplatesDir(): string {
  const entry = nodeRequire.resolve("@sapiom/agent-core");
  return path.resolve(path.dirname(entry), "..", "..", "templates");
}

/**
 * Agent-facing one-liner about a schedule's health: surfaces recent fire failures (with the
 * executionId to inspect) or the next fire time, so the agent knows the next action without
 * re-deriving it from the raw fire ledger. `recentFires` is newest-first.
 */
function scheduleHint(schedule: ScheduleDetail): string | undefined {
  const failed = schedule.recentFires.filter((f) => f.state === "failed");
  if (failed.length > 0) {
    const latest = failed[0];
    const where = latest.executionId
      ? ` — inspect execution ${latest.executionId} with sapiom_dev_agents_inspect`
      : "";
    return `${failed.length} of the last ${schedule.recentFires.length} fires failed${where}.`;
  }
  if (schedule.status === "active" && schedule.nextFireAt)
    return `Active — next fire at ${schedule.nextFireAt}.`;
  if (schedule.status === "active" && schedule.kind === "webhook")
    return `Armed — fires on every signed POST to the hook URL (publicId ${schedule.publicId}, secret v${schedule.secretVersion}). The secret was shown once at create/rotate time; rotate with sapiom_dev_agents_schedule_secret if it is lost.`;
  if (schedule.status === "active" && schedule.kind === "event")
    return `Armed — fires on every '${schedule.eventType}' event this tenant emits (POST /v1/workflows/events with { type, payload }).`;
  if (schedule.status === "completed") return "Completed — no further fires.";
  if (schedule.status === "disabled")
    return schedule.revokedAt
      ? "Revoked — the hook rejects every request; create a new webhook trigger to hand the sender a fresh URL + secret."
      : "Cancelled — no further fires.";
  return undefined;
}

/**
 * How a sender must sign a POST to a webhook trigger. Stated in the tool result rather than
 * left to memory: the secret is shown once, and the sender the agent is about to configure has
 * to compute exactly this or every delivery 401s. Mirrors the engine's `hook-signature.ts`.
 */
const WEBHOOK_SIGNING_SCHEME = {
  algorithm: "HMAC-SHA256, lowercase hex",
  signedString:
    "<X-Sapiom-Timestamp>.<X-Sapiom-Event-Id>.<raw request body bytes>",
  headers: {
    "X-Sapiom-Timestamp":
      "Unix epoch MILLISECONDS, digits only; rejected outside a ±5 minute window",
    "X-Sapiom-Event-Id":
      "sender-chosen delivery id, [A-Za-z0-9_-]{1,128}; the same id is deduplicated, so retries are safe",
    "X-Sapiom-Signature": "the HMAC hex digest",
  },
  body: "a JSON object (up to 1 MiB) — it becomes the run input, folded over the trigger's stored `input`",
  response:
    "202 { receiptId, duplicate } on accept; 401 for a bad or stale signature, revoked hook, or unknown URL",
  example:
    "const ts = String(Date.now()); const id = crypto.randomUUID(); const sig = crypto.createHmac('sha256', secret).update(`${ts}.${id}.${body}`).digest('hex');",
  thirdPartySenders:
    "Slack, Meta, Stripe, GitHub and similar sign with THEIR scheme and cannot produce this HMAC. Point them at an App Link `/hook/*` receiver (webhooksEnabled) that verifies their signature, or at a small translator that re-signs and forwards here.",
} as const;

/**
 * Shape the create result for the agent: a webhook create is the one response carrying the
 * secret, and it must leave with the URL, the scheme, and the shown-once warning attached.
 */
function scheduleCreateResult(
  schedule: CreateScheduleResult,
): Record<string, unknown> {
  const { secret, url, ...detail } = schedule;
  const hint = scheduleHint(detail);
  if (schedule.kind !== "webhook" || !secret || !url) {
    return { schedule: detail, ...(hint ? { hint } : {}) };
  }
  return {
    schedule: detail,
    webhook: {
      url,
      secret,
      secretVersion: detail.secretVersion,
      signing: WEBHOOK_SIGNING_SCHEME,
    },
    hint: `Webhook trigger armed at ${url}. The secret above is shown ONCE — it is derived, never stored, and cannot be read back; hand it to the sender now, or rotate later with sapiom_dev_agents_schedule_secret. Every POST must carry X-Sapiom-Timestamp / X-Sapiom-Event-Id / X-Sapiom-Signature computed as described in \`webhook.signing\`.`,
  };
}

export function register(server: McpServer, env: ResolvedEnvironment): void {
  // ── Local authoring tools (no account or capability spend) ───────────────────

  registerTool(
    server,
    "sapiom_dev_agents_scaffold",
    "Scaffold a new Sapiom agent project into <dir>. Produces a TypeScript project with a starter agent in index.ts and its dependencies installed (best-effort; if the install was skipped offline, run `npm install` in <dir>). After scaffolding, the author writes step definitions and uses sapiom_dev_agents_run_local to test them.",
    {
      dir: z
        .string()
        .min(1)
        .describe(
          "Target directory for the new project (created if absent; must otherwise be empty, except for Agent Studio's private .sapiom directory).",
        ),
      template: z
        .string()
        .optional()
        .describe(
          "Template name. 'default' (a minimal two-step starter) or 'coding-pause' (the launch + pauseUntilSignal + resume pattern for a non-blocking coding-agent run). Defaults to 'default'.",
        ),
    },
    async ({ dir, template }) => {
      try {
        return ok(
          await scaffold({
            targetDir: dir,
            template,
            templatesDir: coreTemplatesDir(),
            // Install deps up front so the Studio Canvas can bundle the new
            // project on its first (unprompted) render — its extraction resolves
            // @sapiom/agent, zod, … from the project's own node_modules, so a
            // never-installed project would otherwise open with a
            // "Could not resolve …" render error. Best-effort: a failed install
            // still returns a successful scaffold.
            installDependencies: true,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    server,
    "sapiom_dev_agents_check",
    "Validate an agent locally: typecheck, bundle and import index.ts, derive the manifest, and check the step graph. Needs no Sapiom account or service call; author-written top-level side effects still run when the definition is imported. Returns the agent name, step count, the manifest (which contains the full step graph for visualization), and any graph warnings.",
    {
      dir: z
        .string()
        .optional()
        .describe(
          "Project directory (defaults to the current working directory).",
        ),
    },
    async ({ dir }) => {
      try {
        return ok(await check({ sourceDir: dir ?? process.cwd() }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    server,
    "sapiom_dev_agents_run_local",
    [
      "Execute an agent on the local machine, running the author's actual step code with every ctx.sapiom.* capability call resolved from stubs (no Sapiom account, capability request, or capability spend). Author code is ordinary local code: its own filesystem, process, environment, and network effects remain real.",
      "Returns { outcome, output, steps[], unusedStubs[], stubWarnings[] }. outcome is 'completed' | 'failed' | 'paused' | 'running'. A paused dispatch (e.g. models.coding.launch) is auto-resumed locally with its stub result, so the happy path runs end-to-end.",
      "Returns `unusedStubs` (supplied stub keys that matched no call — a typo or wrong path form) and `stubWarnings` (a stub key matched but its value was the wrong shape for the capability). Check both: a green run with a non-empty unusedStubs/stubWarnings usually means your stub didn't take effect.",
      "Stub shape: { version: 1, steps: { <stepName>: { <methodPath>: <response> } } }. The response is the value that call returns verbatim — e.g. `repositories.list` takes the array list() should return ([{ slug, cloneUrl }]), not a wrapped/sequence form. For a dispatched run, stub `models.coding.run` (or `models.coding.launch`) in the step that launches it; that value becomes both the run result and the payload the paused step resumes with — set status:'failed' there to exercise the failure branch.",
    ].join("\n"),
    {
      dir: z
        .string()
        .optional()
        .describe(
          "Project directory (defaults to the current working directory).",
        ),
      input: z
        .unknown()
        .optional()
        .describe("The agent's entry-step input (any JSON value)."),
      stubs: z
        .unknown()
        .optional()
        .describe(
          "Stub file object: { version, steps: { <step>: { <method.path>: <response> } } }. Each response is returned verbatim; an array is the actual response only for a list-returning method, not a sequence of responses.",
        ),
      maxAttemptsPerStep: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Retry cap per step (default 3)."),
    },
    async ({ dir, input, stubs, maxAttemptsPerStep }) => {
      try {
        const parsed: StubFile | undefined =
          stubs === undefined ? undefined : parseStubFile(coerceJson(stubs));
        return ok(
          await runLocalFromDir({
            sourceDir: dir ?? process.cwd(),
            input: coerceJson(input),
            stubs: parsed,
            maxAttemptsPerStep,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── Networked tools (require authentication) ───────────────────────────────

  registerTool(
    server,
    "sapiom_dev_agents_link",
    "Resolve a hosted agent by name (or create it with create:true) and cache its id in the project's sapiom.json. Run this before deploy.",
    {
      dir: z
        .string()
        .optional()
        .describe(
          "Project directory (defaults to the current working directory).",
        ),
      name: z
        .string()
        .optional()
        .describe(
          "Agent name (matches defineAgent({ name })). Defaults to the agent's name read from index.ts.",
        ),
      create: z
        .boolean()
        .optional()
        .describe("Create the agent if it does not exist."),
    },
    async ({ dir, name, create }) => {
      const client = await gatewayClient(env);
      if (!client) return NOT_AUTHED;
      try {
        const projectDir = dir ?? process.cwd();
        // Default the link name to the agent's own name (from index.ts)
        // so the link matches what deploy ships — the directory name can drift
        // from defineAgent({ name }).
        let linkName = name;
        if (!linkName) {
          try {
            linkName = (await check({ sourceDir: projectDir })).name;
          } catch {
            // Couldn't read the manifest — fall through to the explicit error.
          }
        }
        if (!linkName) {
          return fail(
            new AgentOperationError({
              code: "NAME_REQUIRED",
              message: "No agent name to link.",
              hint: "Pass name, or ensure index.ts bundles (run check) so the name can be read from defineAgent({ name }).",
            }),
          );
        }
        const result = await link({ name: linkName, create }, client);
        writeConfig(projectDir, {
          definitionId: result.definitionId,
          name: result.name,
        });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    server,
    "sapiom_dev_agents_clone",
    [
      "Materialize a Sapiom agent locally. Given a template id (from the gallery) it forks the template into a repo you own; given an existing fork id it re-clones that fork; given a deployed agent's definitionId it clones the engine's live build-repo source directly (no fork step, always current) and pre-links the checkout. Either way it mints a short-lived, repo-scoped clone credential, git-clones the repo into <dir>, and writes sapiom.json recording the provenance.",
      "After cloning: read the project's AGENTS.md, install its dependencies, then _check → _run_local. Before cloud work, authenticate and run _link → _deploy → _run → _inspect. A templateId/forkId clone is source only and has no dashboard agent until link/deploy; a definitionId clone is already linked because sapiom.json contains its definitionId.",
      "Pass exactly one of templateId, forkId, or definitionId. The clone credential is single-repo, read-only, and ~1h-lived — it is used for the clone and discarded (never stored in sapiom.json).",
    ].join("\n"),
    {
      dir: z
        .string()
        .min(1)
        .describe(
          "Target directory to clone into (created if absent; must otherwise be empty, except for Agent Studio's private .sapiom directory).",
        ),
      templateId: z
        .string()
        .optional()
        .describe(
          "Registry template id to fork then clone (e.g. 'web-research-digest'). Mutually exclusive with forkId and definitionId.",
        ),
      forkId: z
        .string()
        .optional()
        .describe(
          "Existing fork id to clone (skips the fork step). Mutually exclusive with templateId and definitionId.",
        ),
      definitionId: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          "Deployed agent's definition id to pull local (e.g. from the dashboard URL or a prior link/deploy). Clones the engine's current build-repo source directly, skipping the fork step, and pre-links the checkout (sapiom.json is written with this id, so sapiom_dev_agents_link is not needed before deploy). Accepts a number or string — the engine id is a bigint. Mutually exclusive with templateId and forkId.",
        ),
    },
    async ({ dir, templateId, forkId, definitionId }) => {
      const client = await gatewayClient(env);
      if (!client) return NOT_AUTHED;
      try {
        const result = await clone(
          {
            templateId,
            forkId,
            // Normalize the harness's number-typed definitionId to agent-core's
            // string convention at this boundary — see clone.ts's module
            // docstring for the full drift note (SAP-1839).
            definitionId:
              definitionId === undefined ? undefined : String(definitionId),
            targetDir: dir,
          },
          client,
        );
        const hint = result.definitionId
          ? `Cloned into ${result.targetDir}. Already linked to definition ${result.definitionId} — read AGENTS.md, install dependencies, then _check → _run_local before _deploy → _run → _inspect (no link needed).`
          : `Cloned into ${result.targetDir}. Next: read AGENTS.md, install dependencies, then _check → _run_local. Authenticate before sapiom_dev_agents_link → _deploy → _run → _inspect.`;
        return ok({ ...result, hint });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    server,
    "sapiom_dev_agents_deploy",
    "Deploy the linked agent: bundle the current local source (including uncommitted source), push a synthesized build tree, trigger a metered cloud build, and wait for it to finish. The project must be linked (sapiom.json) and a git repo with at least one commit.",
    {
      dir: z
        .string()
        .optional()
        .describe(
          "Project directory (defaults to the current working directory).",
        ),
      branch: z
        .string()
        .optional()
        .describe("Branch to push to (default 'main')."),
    },
    async ({ dir, branch }) => {
      const client = await gatewayClient(env);
      if (!client) return NOT_AUTHED;
      try {
        const projectDir = dir ?? process.cwd();
        const cfg = requireConfig(projectDir);
        return ok(
          await deploy(
            { projectDir, definitionId: cfg.definitionId, branch },
            client,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    server,
    "sapiom_dev_agents_run",
    "Start a real (cloud) execution of the linked agent. Use sapiom_dev_agents_inspect to follow it.",
    {
      dir: z
        .string()
        .optional()
        .describe(
          "Project directory (defaults to the current working directory).",
        ),
      input: z
        .unknown()
        .optional()
        .describe("The agent's entry-step input (any JSON value)."),
    },
    async ({ dir, input }) => {
      const client = await gatewayClient(env);
      if (!client) return NOT_AUTHED;
      try {
        const cfg = requireConfig(dir ?? process.cwd());
        // Coerce a string-serialized input back to JSON (some MCP clients
        // stringify object-valued args), mirroring run_local — the execution API
        // requires an object, so a raw `"{}"` string would be rejected. Default an
        // absent input to {} (the entry step's empty input).
        const started = await run(
          { definitionId: cfg.definitionId, input: coerceJson(input) ?? {} },
          client,
        );
        // Hand back the webapp link so the caller can open the run it just
        // started without reconstructing the route.
        return ok({
          ...started,
          webappUrl: webappRunUrl(
            env.appURL,
            cfg.definitionId,
            started.executionId,
          ),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    server,
    "sapiom_dev_agents_inspect",
    "Inspect a cloud execution (its steps and errors) by executionId, a build by buildRunId, or list recent executions when neither is given. On a failed step, pull its input here to reproduce the failure locally with run_local. When inspecting an execution, the result includes a `webappUrl` to open that run in the webapp.\n\nBy default the execution is returned COMPACT: identity/status/timestamps + a per-step summary (name/order/attempt/status/error-message) with a `has` flag-set and a `sizes` hint (char counts of the omitted input/output/logs/events/sharedState bodies). Full step bodies are NOT included by default — they can be multiple MB. To pull a specific step's heavy fields, pass `step` (its name or order, from the compact list) with `include` (e.g. ['input','error']); optionally narrow to one `attempt`. Debug loop: inspect(executionId) → see step N failed → inspect(executionId, step:'<name>', include:['input','error']) → feed that input to run_local. Every field is capped to a char budget; an over-budget value is truncated with a marker pointing at `webappUrl`.\n\nReads are a fresh point-in-time snapshot. To wait for a still-running execution to finish, set wait:true (the tool polls until it settles or the wait window elapses) — do NOT sleep-and-poll this tool yourself. If a wait returns waiting:true, just call inspect again with wait:true.",
    {
      dir: z
        .string()
        .optional()
        .describe(
          "Project directory (for build inspection, which needs the linked id).",
        ),
      executionId: z.string().optional().describe("Execution to inspect."),
      buildRunId: z
        .string()
        .optional()
        .describe("Build to inspect (requires a linked project)."),
      step: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          "Expand one step's heavy fields: its stepName or stepOrder (from the compact step list). Pair with `include` to choose which fields.",
        ),
      attempt: z
        .number()
        .int()
        .optional()
        .describe(
          "Restrict expansion to a single attempt of the selected `step` (a retried step has several). Omit to expand every attempt of that step.",
        ),
      include: z
        .array(z.enum(INCLUDABLE_FIELDS))
        .optional()
        .describe(
          "Heavy step fields to expand for the selected `step`: 'input' | 'output' | 'logs' | 'events' | 'sharedState' | 'error'. Ignored without `step`. Each is capped to the char budget.",
        ),
      wait: z
        .boolean()
        .optional()
        .describe(
          "When inspecting an executionId, block until it reaches a terminal state (or settles on a pause needing a signal) instead of returning the current snapshot. Lets the tool own the polling so you don't have to.",
        ),
      maxWaitSeconds: z
        .number()
        .optional()
        .describe(
          "Max seconds to wait when wait:true (default 45, capped at 55). On timeout it returns the latest snapshot with waiting:true — call again to keep waiting.",
        ),
    },
    async ({
      dir,
      executionId,
      buildRunId,
      step,
      attempt,
      include,
      wait,
      maxWaitSeconds,
    }) => {
      const client = await gatewayClient(env);
      if (!client) return NOT_AUTHED;
      try {
        if (buildRunId) {
          const cfg = requireConfig(dir ?? process.cwd());
          return ok(
            await inspectBuild(
              { definitionId: cfg.definitionId, buildRunId },
              client,
            ),
          );
        }
        if (executionId) {
          // Compact-by-default projection options, shared by both return
          // branches so wait:true and the snapshot yield the same bounded shape.
          const projectOpts: Omit<ProjectExecutionOptions, "webappUrl"> = {
            step,
            attempt,
            include,
          };
          if (wait) {
            const maxWaitMs =
              Math.min(Math.max(maxWaitSeconds ?? 45, 1), 55) * 1000;
            const { execution, reason, done } = await waitForExecution(
              { executionId, maxWaitMs },
              client,
            );
            const hint =
              reason === "timeout"
                ? "Still running after the wait window — call inspect again with wait:true to keep waiting."
                : reason === "needs-signal"
                  ? `Paused on signal '${execution.pausedSignalName ?? "?"}' — deliver it with sapiom_dev_agents_signal to resume.`
                  : undefined;
            const webappUrl = webappRunUrl(
              env.appURL,
              execution.definitionId,
              execution.id,
            );
            return ok({
              execution: projectExecutionForTool(execution, {
                ...projectOpts,
                webappUrl,
              }),
              done,
              waiting: !done,
              webappUrl,
              ...(hint ? { hint } : {}),
            });
          }
          const execution = await inspect({ executionId }, client);
          // Self-correcting nudge: on a non-terminal snapshot, point at wait:true
          // so a caller reaches for the tool's loop instead of polling by hand.
          const hint = isExecutionTerminal(execution.status)
            ? undefined
            : `Execution is '${execution.status}', not terminal — call inspect with wait:true to block until it finishes instead of polling manually.`;
          const webappUrl = webappRunUrl(
            env.appURL,
            execution.definitionId,
            execution.id,
          );
          return ok({
            execution: projectExecutionForTool(execution, {
              ...projectOpts,
              webappUrl,
            }),
            webappUrl,
            ...(hint ? { hint } : {}),
          });
        }
        return ok(await listExecutions(client));
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    server,
    "sapiom_dev_agents_signal",
    "Resume a paused cloud execution by delivering a named signal (matched by name + correlationId).",
    {
      executionId: z.string().describe("The paused execution."),
      name: z.string().describe("Signal name to deliver."),
      correlationId: z.string().describe("Signal correlation id."),
      payload: z
        .unknown()
        .optional()
        .describe("Signal payload (any JSON value)."),
    },
    async ({ executionId, name, correlationId, payload }) => {
      const client = await gatewayClient(env);
      if (!client) return NOT_AUTHED;
      try {
        return ok(
          await signal({ executionId, name, correlationId, payload }, client),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── Triggers: schedules, events, webhooks ────────────────────────────────

  registerTool(
    server,
    "sapiom_dev_agents_schedule",
    "Create a trigger for a deployed agent — one of four kinds. 'schedule_cron' (+ cron + timezone) runs it on a recurring schedule; 'schedule_once' (+ at) runs it once at a future time; 'event' (+ eventType) runs it every time this tenant emits that event type via POST /v1/workflows/events; 'webhook' runs it every time an external system POSTs to a public hook URL — the result returns that URL plus a shown-once signing secret and the HMAC-SHA256 scheme the sender must use. Use 'webhook' when an external system should start the agent (\"run when X POSTs to us\") instead of hand-building an HTTP server; third-party senders with their own signature scheme (Slack, Meta, Stripe, GitHub) cannot produce our HMAC, so route those through an App Link /hook/* receiver or a translator. Returns the trigger with its next fire time where it has one. Tip: validate a cron with sapiom_dev_agents_cron_preview first.",
    {
      definition: z
        .string()
        .describe(
          "The agent's tenant-unique slug (the handle it was deployed under).",
        ),
      kind: z
        .enum(["schedule_cron", "schedule_once", "event", "webhook"])
        .describe(
          "'schedule_cron' = recurring; 'schedule_once' = a single delayed run; 'event' = fires on a tenant-emitted event type; 'webhook' = fires on a signed POST to a public URL minted for this trigger.",
        ),
      cron: z
        .string()
        .optional()
        .describe(
          "Cron expression — required for 'schedule_cron'. E.g. '0 9 * * 1-5' = 9am on weekdays.",
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone the cron runs in (e.g. 'America/New_York'). Defaults to UTC.",
        ),
      at: z
        .string()
        .optional()
        .describe(
          "ISO 8601 fire time — required for 'schedule_once'. E.g. '2026-07-01T17:00:00Z'.",
        ),
      eventType: z
        .string()
        .optional()
        .describe(
          "Event type to match — required for 'event'. Lowercase dot-separated segments, e.g. 'lead.created'; the 'sapiom.*' namespace is reserved. Emit it with POST /v1/workflows/events { type, payload }.",
        ),
      input: z
        .unknown()
        .optional()
        .describe(
          "Execution input passed to each run (any JSON value). For 'event' and 'webhook' the inbound payload is folded over this (payload wins on key conflicts).",
        ),
      startAt: z
        .string()
        .optional()
        .describe("Cron only: ISO time before which no occurrence fires."),
      endAt: z
        .string()
        .optional()
        .describe("Cron only: ISO time after which the schedule completes."),
      policy: z
        .unknown()
        .optional()
        .describe(
          "Cron only: { catchupPolicy?: 'skip'|'all', overlapPolicy?: 'allow', jitterMs?: number }.",
        ),
    },
    async ({
      definition,
      kind,
      cron,
      timezone,
      at,
      eventType,
      input,
      startAt,
      endAt,
      policy,
    }) => {
      const client = await gatewayClient(env);
      if (!client) return NOT_AUTHED;
      try {
        const schedule = await createSchedule(
          {
            definition,
            kind,
            cron,
            timezone,
            at,
            eventType,
            input: coerceJson(input),
            startAt,
            endAt,
            policy: coerceJson(policy) as SchedulePolicy | undefined,
          },
          client,
        );
        return ok(scheduleCreateResult(schedule));
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    server,
    "sapiom_dev_agents_schedule_inspect",
    "Inspect triggers of any kind (cron, one-off, event, webhook). With scheduleId: returns one trigger's config, next fire time (schedules), eventType (event), publicId / secretVersion / graceUntil / revokedAt (webhook — never the secret, which is shown only at create/rotate), and recent fire history (each with the run's executionId, and the inbound receiptId for event/webhook fires) — use this to debug a misbehaving trigger, then inspect a failed run's executionId with sapiom_dev_agents_inspect. With definition (slug) and no scheduleId: lists that agent's triggers.",
    {
      scheduleId: z
        .string()
        .optional()
        .describe(
          "Inspect one trigger (detail + recent fires + a health hint).",
        ),
      definition: z
        .string()
        .optional()
        .describe(
          "List triggers for this agent slug (used when scheduleId is omitted).",
        ),
      status: z
        .enum(["active", "paused", "completed", "disabled"])
        .optional()
        .describe("Filter the list by status."),
    },
    async ({ scheduleId, definition, status }) => {
      const client = await gatewayClient(env);
      if (!client) return NOT_AUTHED;
      try {
        if (scheduleId) {
          const schedule = await getSchedule(scheduleId, client);
          const hint = scheduleHint(schedule);
          return ok({ schedule, ...(hint ? { hint } : {}) });
        }
        if (definition) {
          return ok(await listSchedules({ definition, status }, client));
        }
        return fail(
          new AgentOperationError({
            code: "BAD_INPUT",
            message:
              "Provide scheduleId (to inspect one) or definition (to list an agent's triggers).",
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    server,
    "sapiom_dev_agents_schedule_cancel",
    "Cancel a trigger of any kind by id. Stops all future fires: a recurring schedule won't re-arm, a pending one-off won't run, an event trigger stops matching, a webhook stops accepting POSTs (401 from then on). Irreversible — recreate to re-arm (a recreated webhook gets a new URL + secret). For a webhook whose secret leaked but whose URL should keep working, rotate with sapiom_dev_agents_schedule_secret instead.",
    {
      scheduleId: z.string().describe("The trigger to cancel."),
    },
    async ({ scheduleId }) => {
      const client = await gatewayClient(env);
      if (!client) return NOT_AUTHED;
      try {
        return ok(await cancelSchedule(scheduleId, client));
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    server,
    "sapiom_dev_agents_schedule_secret",
    "Webhook-trigger secret lifecycle. 'rotate' = planned hygiene: mints a new secret (returned ONCE, with the hook URL beside it so the sender can be reconfigured in one step) while the previous secret keeps verifying for a 24h grace. 'complete_rotation' = the sender has moved; end the grace now so the old secret stops verifying immediately. 'revoke' = compromise: the hook rejects every request from now on and any open grace dies with it — irreversible, create a new webhook trigger to hand the sender a fresh URL + secret. Only valid on kind 'webhook'.",
    {
      scheduleId: z.string().describe("The webhook trigger."),
      action: z
        .enum(["rotate", "complete_rotation", "revoke"])
        .describe(
          "'rotate' (new secret, old one verifies for 24h) | 'complete_rotation' (end that grace now) | 'revoke' (kill the hook).",
        ),
    },
    async ({ scheduleId, action }) => {
      const client = await gatewayClient(env);
      if (!client) return NOT_AUTHED;
      try {
        if (action === "rotate") {
          const { secret, url, ...schedule } = await rotateScheduleSecret(
            scheduleId,
            client,
          );
          return ok({
            schedule,
            webhook: {
              url,
              secret,
              secretVersion: schedule.secretVersion,
              signing: WEBHOOK_SIGNING_SCHEME,
            },
            hint: `Rotated to secret v${schedule.secretVersion}; shown ONCE. The previous secret still verifies until ${schedule.graceUntil ?? "the grace ends"} — reconfigure the sender, then call this tool with action 'complete_rotation' to close the window early.`,
          });
        }
        if (action === "complete_rotation") {
          const schedule = await completeScheduleSecretRotation(
            scheduleId,
            client,
          );
          return ok({
            schedule,
            hint: "Rotation complete — only the current secret verifies now.",
          });
        }
        const schedule = await revokeScheduleSecret(scheduleId, client);
        return ok({
          schedule,
          hint: "Revoked — the hook rejects every request from now on. Create a new webhook trigger to hand the sender a fresh URL + secret.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerTool(
    server,
    "sapiom_dev_agents_cron_preview",
    "Validate a cron expression and preview its next occurrences, creating nothing. Use before sapiom_dev_agents_schedule to confirm a cron + timezone fire when you expect (cron syntax is easy to get subtly wrong).",
    {
      cron: z
        .string()
        .describe("Cron expression to validate, e.g. '0 9 * * 1-5'."),
      timezone: z.string().optional().describe("IANA timezone (default UTC)."),
      count: z
        .number()
        .optional()
        .describe("How many upcoming occurrences to return (default 5)."),
    },
    async ({ cron, timezone, count }) => {
      const client = await gatewayClient(env);
      if (!client) return NOT_AUTHED;
      try {
        return ok(await previewCron({ cron, timezone, count }, client));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
