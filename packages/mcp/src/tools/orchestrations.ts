/**
 * Orchestration authoring tools. Thin wrappers over @sapiom/orchestration-core.
 * Local tools (scaffold / check / run_local) need no network; networked tools
 * (link / deploy / run / inspect / signal) build a client from the cached
 * credential and the environment's API host.
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
  check,
  createClient,
  deploy,
  GatewayClient,
  inspect,
  inspectBuild,
  isExecutionTerminal,
  link,
  listExecutions,
  OrchestrationError,
  parseStubFile,
  requireConfig,
  run,
  runLocalFromDir,
  scaffold,
  signal,
  waitForExecution,
  writeConfig,
  type StubFile,
} from "@sapiom/orchestration-core";
import { readCredentials, type ResolvedEnvironment } from "../credentials.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  let text: string;
  try {
    text = JSON.stringify(data, null, 2);
  } catch (err) {
    // A value in the result resisted serialization. Don't drop the whole
    // payload (e.g. a run_local trace) on the floor — emit a sanitized version
    // that keeps everything serializable and marks the node that failed, so the
    // result stays actionable instead of surfacing as an opaque crash.
    text = JSON.stringify(
      {
        _serializationError: err instanceof Error ? err.message : String(err),
        data: sanitize(data),
      },
      null,
      2,
    );
  }
  return { content: [{ type: "text" as const, text }] };
}

/** Best-effort deep copy that replaces any node which throws on access or
 *  serialization with a marker, so a single bad value can't sink the response. */
function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => sanitize(v, seen));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      try {
        out[key] = sanitize((value as Record<string, unknown>)[key], seen);
      } catch (err) {
        out[key] =
          `[unserializable: ${err instanceof Error ? err.message : String(err)}]`;
      }
    }
    return out;
  } catch (err) {
    return `[unserializable: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

function fail(err: unknown): ToolResult {
  const structured =
    err instanceof OrchestrationError
      ? err.toStructured()
      : {
          code: "UNEXPECTED",
          message: err instanceof Error ? err.message : String(err),
        };
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: structured }, null, 2),
      },
    ],
    isError: true,
  };
}

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
 * Locate the bundled templates directory of @sapiom/orchestration-core. This
 * ESM server has no `__dirname`, so the templates dir is resolved from the
 * package's entry and passed to `scaffold` explicitly.
 */
function coreTemplatesDir(): string {
  const entry = nodeRequire.resolve("@sapiom/orchestration-core");
  return path.resolve(path.dirname(entry), "..", "..", "templates");
}

async function gatewayClient(
  env: ResolvedEnvironment,
): Promise<GatewayClient | null> {
  const creds = await readCredentials(env.name);
  if (!creds) return null;
  return createClient({ apiKey: creds.apiKey, host: env.apiURL });
}

const NOT_AUTHED = fail(
  new OrchestrationError({
    code: "NOT_AUTHENTICATED",
    message: "Not authenticated.",
    hint: "Use the sapiom_authenticate tool first.",
  }),
);

export function register(server: McpServer, env: ResolvedEnvironment): void {
  // ── Local tools (no network) ──────────────────────────────────────────────

  server.tool(
    "sapiom_dev_orchestrations_scaffold",
    "Scaffold a new Sapiom orchestration project into <dir>. Produces an npm-install-ready TypeScript project with a starter orchestration in index.ts. After scaffolding, the author writes step definitions and uses sapiom_dev_orchestrations_run_local to test them.",
    {
      dir: z
        .string()
        .min(1)
        .describe(
          "Target directory for the new project (created if absent; must be empty).",
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
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "sapiom_dev_orchestrations_check",
    "Validate an orchestration locally: bundle index.ts, derive the manifest, and check the step graph. Offline and instant. Returns the orchestration name, step count, the manifest (which contains the full step graph for visualization), and any graph warnings.",
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

  server.tool(
    "sapiom_dev_orchestrations_run_local",
    [
      "Execute an orchestration entirely on the local machine, running the author's actual step code with every ctx.sapiom.* capability call resolved from stubs (no real capability calls, no cost, instant).",
      "Returns { outcome, output, steps[], unusedStubs[], stubWarnings[] }. outcome is 'completed' | 'failed' | 'paused' | 'running'. A paused dispatch (e.g. agent.coding.launch) is auto-resumed locally with its stub result, so the happy path runs end-to-end.",
      "Returns `unusedStubs` (supplied stub keys that matched no call — a typo or wrong path form) and `stubWarnings` (a stub key matched but its value was the wrong shape for the capability). Check both: a green run with a non-empty unusedStubs/stubWarnings usually means your stub didn't take effect.",
      "Stub shape: { version: 1, steps: { <stepName>: { <methodPath>: <response> } } }. The response is the value that call returns verbatim — e.g. `repositories.list` takes the array list() should return ([{ slug, cloneUrl }]), not a wrapped/sequence form. For a dispatched run, stub `agent.coding.run` (or `agent.coding.launch`) in the step that launches it; that value becomes both the run result and the payload the paused step resumes with — set status:'failed' there to exercise the failure branch.",
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
        .describe("The workflow's entry-step input (any JSON value)."),
      stubs: z
        .unknown()
        .optional()
        .describe(
          "Stub file object: { version, steps: { <step>: { <method.path>: <response> | [<response>] } } }.",
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

  server.tool(
    "sapiom_dev_orchestrations_link",
    "Resolve a hosted orchestration by name (or create it with create:true) and cache its id in the project's sapiom.json. Run this before deploy.",
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
          "Orchestration name (matches defineOrchestration({ name })). Defaults to the orchestration's name read from index.ts.",
        ),
      create: z
        .boolean()
        .optional()
        .describe("Create the orchestration if it does not exist."),
    },
    async ({ dir, name, create }) => {
      const client = await gatewayClient(env);
      if (!client) return NOT_AUTHED;
      try {
        const projectDir = dir ?? process.cwd();
        // Default the link name to the orchestration's own name (from index.ts)
        // so the link matches what deploy ships — the directory name can drift
        // from defineOrchestration({ name }).
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
            new OrchestrationError({
              code: "NAME_REQUIRED",
              message: "No orchestration name to link.",
              hint: "Pass name, or ensure index.ts bundles (run check) so the name can be read from defineOrchestration({ name }).",
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

  server.tool(
    "sapiom_dev_orchestrations_deploy",
    "Deploy the linked orchestration: push the current git commit, trigger a build, and wait for it to finish. The project must be linked (sapiom.json) and a git repo with at least one commit.",
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

  server.tool(
    "sapiom_dev_orchestrations_run",
    "Start a real (cloud) execution of the linked orchestration. Use sapiom_dev_orchestrations_inspect to follow it.",
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
        .describe("The workflow's entry-step input (any JSON value)."),
    },
    async ({ dir, input }) => {
      const client = await gatewayClient(env);
      if (!client) return NOT_AUTHED;
      try {
        const cfg = requireConfig(dir ?? process.cwd());
        return ok(await run({ definitionId: cfg.definitionId, input }, client));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "sapiom_dev_orchestrations_inspect",
    "Inspect a cloud execution (its steps and errors) by executionId, a build by buildRunId, or list recent executions when neither is given. On a failed step, pull its input here to reproduce the failure locally with run_local.\n\nReads are a fresh point-in-time snapshot. To wait for a still-running execution to finish, set wait:true (the tool polls until it settles or the wait window elapses) — do NOT sleep-and-poll this tool yourself. If a wait returns waiting:true, just call inspect again with wait:true.",
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
    async ({ dir, executionId, buildRunId, wait, maxWaitSeconds }) => {
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
                  ? `Paused on signal '${execution.pausedSignalName ?? "?"}' — deliver it with sapiom_dev_orchestrations_signal to resume.`
                  : undefined;
            return ok({
              execution,
              done,
              waiting: !done,
              ...(hint ? { hint } : {}),
            });
          }
          const { execution } = await inspect({ executionId }, client);
          // Self-correcting nudge: on a non-terminal snapshot, point at wait:true
          // so a caller reaches for the tool's loop instead of polling by hand.
          const hint = isExecutionTerminal(execution.status)
            ? undefined
            : `Execution is '${execution.status}', not terminal — call inspect with wait:true to block until it finishes instead of polling manually.`;
          return ok({ execution, ...(hint ? { hint } : {}) });
        }
        return ok(await listExecutions(client));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "sapiom_dev_orchestrations_signal",
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
}
