/**
 * sapiom_send_feedback — relay a user's product feedback to the Sapiom team.
 *
 * The agent supplies only what a human said: the feedback itself, plus an
 * optional plain-language note about what they were doing. Everything else —
 * package version, platform, environment, clock — is gathered here, so the
 * model never has to guess it and, more importantly, has no reason to go read
 * it off the machine.
 *
 * Success returns prose: a receipt is a message for a human, not a payload to
 * parse, and `registerTool` does not inspect a non-error result. Failure
 * returns the shared structured envelope, which is the only shape
 * `classifyErrorResult` can turn into a real `error_class`.
 *
 * Note on reach: `registerTool` records tool arguments in full on the
 * `tool.call` analytics event, so `message` and `context` land in the analytics
 * pipeline as well as the feedback table. Both are Sapiom-owned, and the field
 * descriptions below are what keep code and secrets out of either one.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendFeedback } from "@sapiom/agent-core";

import { type ResolvedEnvironment } from "../credentials.js";
import { registerTool } from "../register-tool.js";
import { packageVersion } from "../version.js";
import { fail, gatewayClient, NOT_AUTHED } from "./shared.js";

const DESCRIPTION =
  "Send the user's feedback about Sapiom — a bug, a rough edge, a feature request, or praise — " +
  "to the Sapiom team. Reach for this when the user says something like \"this is broken\", " +
  "\"tell Sapiom\", \"file feedback\", or \"this should work differently\": confirm the wording " +
  "with them, then send their words as `message`. NEVER put file contents, code snippets, logs, " +
  "stack traces, environment variables, API keys, or any other secret in `message` or `context` — " +
  "both fields are plain prose only. Package version, platform, environment, and timestamp are " +
  "attached automatically; do not restate them.";

/**
 * Client-side auto-context. An allowlist of build/runtime facts, deliberately
 * narrow: no filesystem paths, no repo identity, no user content, and no tenant
 * identity (the backend resolves that from the API key).
 *
 * A `type` alias rather than an `interface` on purpose — an interface has no
 * implicit index signature and so is not assignable to the SDK's
 * `Record<string, unknown>`.
 */
type FeedbackClientMeta = {
  client: string;
  clientVersion: string;
  harnessVersion?: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  environment: string;
  sentAt: string;
};

function clientMeta(env: ResolvedEnvironment): FeedbackClientMeta {
  // Nothing sets this today — the harness passes only SAPIOM_ENVIRONMENT to the
  // sapiom-dev child. Read it anyway so a future harness can advertise itself
  // without an MCP release, and omit the key when absent: a fabricated
  // "unknown" would poison every aggregation over this field.
  const harnessVersion = process.env.SAPIOM_HARNESS_VERSION;
  return {
    client: "sapiom-mcp",
    clientVersion: packageVersion(),
    ...(harnessVersion ? { harnessVersion } : {}),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    // Verbatim, not remapped to prod/local: resolveEnvironment has already
    // collapsed the aliases, and the value may be an arbitrary custom name from
    // ~/.sapiom/credentials.json.
    environment: env.name,
    // The client's clock, hence the name — the backend keeps its own createdAt.
    sentAt: new Date().toISOString(),
  };
}

export function register(server: McpServer, env: ResolvedEnvironment): void {
  registerTool(
    server,
    "sapiom_send_feedback",
    DESCRIPTION,
    {
      message: z
        .string()
        // Trim before the length check: `min(1)` alone accepts "   ", and a
        // whitespace-only row would land in the team's Slack inbox as a blank
        // message. This is the only layer that knows the field is prose.
        .trim()
        .min(1)
        .describe(
          "The user's feedback in their own words: what's wrong, what they expected, or what " +
            "they want. Plain language only — no code, logs, stack traces, or secrets.",
        ),
      context: z
        .string()
        .optional()
        .describe(
          "Optional one- or two-sentence plain-language summary of what the user was doing when " +
            'the feedback came up (e.g. "deploying an agent after run_local passed"). Never ' +
            "include file contents, code snippets, logs, stack traces, environment variables, " +
            "API keys, or tokens.",
        ),
    },
    async ({ message, context }) => {
      const client = await gatewayClient(env);
      if (!client) return NOT_AUTHED;
      try {
        const { id } = await sendFeedback(
          { message, context, clientMeta: clientMeta(env) },
          client,
        );
        return {
          content: [
            {
              type: "text" as const,
              // `id` is optional — a 201 with an empty body must not render
              // "reference undefined" at a user.
              text: id
                ? `Thanks — your feedback was sent to the Sapiom team (reference ${id}).`
                : "Thanks — your feedback was sent to the Sapiom team.",
            },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );
}
