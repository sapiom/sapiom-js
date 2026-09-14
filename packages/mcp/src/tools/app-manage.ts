/**
 * App Link management from the local MCP (SAP-3178):
 *
 *   `sapiom_dev_app_list`      GET    /v1/app-links
 *   `sapiom_dev_app_settings`  PATCH  /v1/app-links/{id}
 *   `sapiom_dev_app_delete`    DELETE /v1/app-links/{id}
 *
 * `sapiom_dev_app_publish` (app-publish.ts) publishes, and only publishes. Until
 * these tools, everything else about a link — `webhooksEnabled`, visibility,
 * the daily spend cap, the wake rate limit, listing, deleting — was REST-only
 * behind an `org.write` key, so a Studio user who published a webhook receiver
 * could not turn webhooks on from Studio; someone had to do it by hand.
 *
 * Authority is the shape of every error here. The backend gates `PATCH` and
 * `DELETE` on `org.write` at the route, and `GET` on `org.read`; publish
 * authority (`org.app_links.publish`, what a workflow run's `sat_` carries)
 * holds neither. A refusal therefore comes back as a message that NAMES the
 * permission and the fields it was asked to change, so the agent tells the user
 * — instead of a bare 403 the agent would retry, or a silent no-op the user
 * would take for success.
 *
 * A link is addressed by `slug` (its stable identity — what `_publish` took) or
 * by `appLinkId` (what `_publish` returned). The slug resolves through the list
 * route; the id is one direct GET. Both reads are gated on `org.read` — the id
 * path saves a round trip, not a permission.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PreviewOperationError } from "@sapiom/sandbox-preview";
import { z } from "zod";

import { readCredentials, type ResolvedEnvironment } from "../credentials.js";
import { registerTool } from "../register-tool.js";
import {
  appLinksFetch,
  asAppLink,
  codeFrom,
  fail,
  messageFrom,
  NOT_AUTHED,
  ok,
  webhookUrlOf,
  type AppLinkListWire,
  type AppLinkWire,
  type ErrorBody,
} from "./app-links-api.js";

/** Same shape as the backend's `APP_LINK_SLUG_PATTERN` (app-links.types.ts). */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Same shape as the backend's `USD_DECIMAL_PATTERN`. */
const USD_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;

/**
 * The management fields `_settings` may send, in the order they are reported.
 * Mirrors the backend's `APP_LINK_MANAGEMENT_FIELDS` minus `sandboxTier` /
 * `sandboxTtl`, which describe the wake and are not a link-level decision an
 * agent should be making.
 */
const SETTINGS_FIELDS = [
  "webhooksEnabled",
  "visibility",
  "dailySpendCapUsd",
  "wakeRateLimitPerHour",
] as const;
type SettingsField = (typeof SETTINGS_FIELDS)[number];

/** The permission each route is gated on, by name, for the error copy. */
const PERMISSION = {
  list: "org.read",
  manage: "org.write",
} as const;

/** How the tools address a link. Exactly one of the two is required. */
const TARGET_SHAPE = {
  slug: z
    .string()
    .regex(
      SLUG_PATTERN,
      "slug must match [a-z0-9-]{1,63} and start with a letter or digit",
    )
    .optional()
    .describe(
      "The app link's slug — the URL path segment you published it under. Resolved " +
        "through the list route. Give this OR appLinkId.",
    ),
  appLinkId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "The app link's id, as returned by sapiom_dev_app_publish — one direct lookup " +
        "instead of the list. Give this OR slug.",
    ),
};

// ─── Registration ────────────────────────────────────────────────────────────

export function register(server: McpServer, env: ResolvedEnvironment): void {
  registerList(server, env);
  registerSettings(server, env);
  registerDelete(server, env);
}

function registerList(server: McpServer, env: ResolvedEnvironment): void {
  registerTool(
    server,
    "sapiom_dev_app_list",
    "List your organization's App Links (durable https://apps.sapiom.ai/{org}/{slug} apps " +
      "published with sapiom_dev_app_publish): slug, URL, visibility, whether webhooks are on " +
      "and the /hook URL when they are, daily spend cap, wake rate limit, wake status. Use it to " +
      "find a link before sapiom_dev_app_settings or sapiom_dev_app_delete, or to answer " +
      '"what have we published?". Read-only; needs org.read.',
    {},
    async () => {
      const creds = await readCredentials(env.name);
      if (!creds) return NOT_AUTHED;
      try {
        const links = await listLinks(env.apiURL, creds.apiKey);
        const rows = links.map(describeLink);
        return ok({
          summary:
            rows.length === 0
              ? "No App Links in this organization yet. Publish one with sapiom_dev_app_publish."
              : `${rows.length} App Link${rows.length === 1 ? "" : "s"}: ` +
                rows.map((r) => `${r.slug} (${r.url})`).join(", ") +
                ".",
          count: rows.length,
          links: rows,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

function registerSettings(server: McpServer, env: ResolvedEnvironment): void {
  registerTool(
    server,
    "sapiom_dev_app_settings",
    "Change how a published App Link is exposed: turn webhooks on or off (webhooksEnabled), " +
      "change visibility, set or clear the daily spend cap, set the wake rate limit. Webhooks are " +
      "OFF by default on every link; once on, third parties POST to " +
      "https://apps.sapiom.ai/{org}/{slug}/hook/<path> — the /hook prefix is stripped and the body " +
      "forwarded byte-exact, so Slack/Stripe/GitHub signature checks run inside the app. " +
      "Address the link by slug or appLinkId and send only the fields to change. These settings " +
      "need the org.write permission (sapiom_dev_app_publish's publish authority is not enough): " +
      "when the credential lacks it the error names the permission and the fields — tell the " +
      "user, do not retry. Setting visibility to public needs confirmPublic: true and a " +
      "dailySpendCapUsd; ask the user first. Returns { url, webhookUrl, settings, changed }.",
    {
      ...TARGET_SHAPE,
      webhooksEnabled: z
        .boolean()
        .optional()
        .describe(
          "true to accept third-party webhooks at {url}/hook/<path>; false to stop. Off by default.",
        ),
      visibility: z
        .enum(["organization", "public"])
        .optional()
        .describe(
          '"organization" (members only) or "public" (anyone with the link; requires ' +
            "confirmPublic and a dailySpendCapUsd because your org pays for every wake).",
        ),
      confirmPublic: z
        .boolean()
        .optional()
        .describe(
          'Required with visibility "public": acknowledges that anyone with the link can wake the ' +
            "app and your org pays for it. Ask the user before setting it.",
        ),
      dailySpendCapUsd: z
        .string()
        .regex(
          USD_PATTERN,
          'dailySpendCapUsd must be a decimal USD amount like "5.00"',
        )
        .nullable()
        .optional()
        .describe(
          'Daily spend ceiling as a decimal USD string (e.g. "5.00"), or null to clear it. ' +
            "A public link cannot have its cap cleared.",
        ),
      wakeRateLimitPerHour: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Maximum wakes per hour (cold starts the org will pay for)."),
    },
    async ({ slug, appLinkId, confirmPublic, ...settings }) => {
      const creds = await readCredentials(env.name);
      if (!creds) return NOT_AUTHED;
      try {
        const changed = SETTINGS_FIELDS.filter(
          (field) => settings[field] !== undefined,
        );
        if (changed.length === 0) {
          throw new PreviewOperationError({
            code: "NO_SETTINGS",
            message:
              "No settings given. Nothing was changed. Send at least one of: " +
              `${SETTINGS_FIELDS.join(", ")}.`,
            hint: "To turn webhooks on: { slug, webhooksEnabled: true }.",
          });
        }
        const target = await resolveLink(env.apiURL, creds.apiKey, {
          slug,
          appLinkId,
        });
        const patch: Record<string, unknown> = {};
        for (const field of changed) patch[field] = settings[field];
        if (confirmPublic !== undefined) patch.confirmPublic = confirmPublic;

        const res = await appLinksFetch(
          env.apiURL,
          creds.apiKey,
          "PATCH",
          `/v1/app-links/${encodeURIComponent(target.id)}`,
          patch,
        );
        // The PATCH echoes the link; the report below describes THAT body, not
        // the pre-change `target`. A 2xx that is not a link (a proxy's HTML page
        // answering 200, an unexpected 204) cannot be reported as a change that
        // took effect — falling back to `target` would say "Webhooks are OFF"
        // for a request that asked to turn them on.
        const updated = requireAppLink(
          unwrap(res, {
            action: `Changing ${changed.join(", ")} on the "${target.slug}" app link`,
            permission: PERMISSION.manage,
            fields: changed,
            slug: target.slug,
          }),
          `The App Links API answered the settings change with a success status but not an app link, so whether ${changed.join(", ")} changed on "${target.slug}" is unknown.`,
        );

        return ok({
          summary: summarizeSettings(updated, changed),
          url: updated.url,
          appLinkId: updated.id,
          slug: updated.slug,
          changed,
          settings: settingsOf(updated),
          webhookUrl: updated.webhooksEnabled ? webhookUrlOf(updated) : null,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

function registerDelete(server: McpServer, env: ResolvedEnvironment): void {
  registerTool(
    server,
    "sapiom_dev_app_delete",
    "Delete a published App Link. The https://apps.sapiom.ai/{org}/{slug} URL stops resolving " +
      "(anyone holding it gets a 404), any webhook receiver at its /hook path stops answering, and " +
      "the slug is freed for reuse. Address the link by slug or appLinkId. This is destructive: " +
      "ask the user before calling it, then pass confirm: true. Needs the org.write permission; " +
      "when the credential lacks it the error names the permission — tell the user, do not retry.",
    {
      ...TARGET_SHAPE,
      confirm: z
        .boolean()
        .describe(
          "Must be true. Acknowledges the URL goes down and the slug is freed. Ask the user first.",
        ),
    },
    async ({ slug, appLinkId, confirm }) => {
      const creds = await readCredentials(env.name);
      if (!creds) return NOT_AUTHED;
      try {
        if (confirm !== true) {
          throw new PreviewOperationError({
            code: "CONFIRM_REQUIRED",
            message:
              "Deleting an App Link takes its URL down for everyone holding it and frees the slug. Nothing was deleted.",
            hint: "Ask the user, then retry with confirm: true.",
          });
        }
        const target = await resolveLink(env.apiURL, creds.apiKey, {
          slug,
          appLinkId,
        });
        const res = await appLinksFetch(
          env.apiURL,
          creds.apiKey,
          "DELETE",
          `/v1/app-links/${encodeURIComponent(target.id)}`,
        );
        unwrap(res, {
          action: `Deleting the "${target.slug}" app link`,
          permission: PERMISSION.manage,
          slug: target.slug,
        });
        return ok({
          summary:
            `Deleted "${target.name}" (${target.url}). The URL no longer resolves and the ` +
            `"${target.slug}" slug is free to reuse.`,
          appLinkId: target.id,
          slug: target.slug,
          url: target.url,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

async function listLinks(
  apiURL: string,
  apiKey: string,
): Promise<AppLinkWire[]> {
  const res = await appLinksFetch(apiURL, apiKey, "GET", "/v1/app-links");
  const data = unwrap(res, {
    action: "Listing app links",
    permission: PERMISSION.list,
  }) as Partial<AppLinkListWire> | undefined;
  const items = Array.isArray(data?.items) ? data.items : null;
  if (!items) {
    throw new PreviewOperationError({
      code: "UNEXPECTED_RESPONSE",
      message:
        "The App Links API answered with a success status but not a list of app links.",
      hint: "Check the SAPIOM_ENVIRONMENT / api URL this MCP is pointed at, then retry.",
    });
  }
  return items.filter((item): item is AppLinkWire => asAppLink(item) !== null);
}

/**
 * The link the caller means. By id it is one GET (`org.read`, like every read);
 * by slug it is the list route filtered client-side, since the REST surface has
 * no by-slug lookup. Neither is found → `APP_LINK_NOT_FOUND`, which is also what
 * another organization's id resolves to (the backend never says 403 for that).
 */
async function resolveLink(
  apiURL: string,
  apiKey: string,
  target: { slug?: string; appLinkId?: string },
): Promise<AppLinkWire> {
  if (!target.slug && !target.appLinkId) {
    throw new PreviewOperationError({
      code: "TARGET_REQUIRED",
      message:
        "Say which app link: pass slug or appLinkId. Nothing was changed.",
      hint: "sapiom_dev_app_list shows every link in your organization with both.",
    });
  }
  if (target.appLinkId) {
    const res = await appLinksFetch(
      apiURL,
      apiKey,
      "GET",
      `/v1/app-links/${encodeURIComponent(target.appLinkId)}`,
    );
    // A 404 is mapped to APP_LINK_NOT_FOUND by `unwrap`; a 2xx that is not a link
    // is NOT "not found" — it is an answer we cannot read, same as on the PATCH.
    return requireAppLink(
      unwrap(res, {
        action: `Looking up app link ${target.appLinkId}`,
        permission: PERMISSION.list,
        slug: target.appLinkId,
      }),
      `The App Links API answered the lookup of ${target.appLinkId} with a success status but not an app link. Nothing was changed.`,
    );
  }
  const links = await listLinks(apiURL, apiKey);
  const link = links.find((l) => l.slug === target.slug);
  if (link) return link;
  throw notFound(target.slug!);
}

/**
 * A body that MUST be a link, or `UNEXPECTED_RESPONSE`. `listLinks` guards the
 * list shape the same way; this is the single-link twin.
 */
function requireAppLink(data: unknown, message: string): AppLinkWire {
  const link = asAppLink(data);
  if (link) return link;
  throw new PreviewOperationError({
    code: "UNEXPECTED_RESPONSE",
    message,
    hint:
      "Check the SAPIOM_ENVIRONMENT / api URL this MCP is pointed at, then run " +
      "sapiom_dev_app_list to see the link's actual settings before retrying.",
  });
}

function notFound(what: string): PreviewOperationError {
  return new PreviewOperationError({
    code: "APP_LINK_NOT_FOUND",
    message: `No app link "${what}" in your organization. Nothing was changed.`,
    hint: "sapiom_dev_app_list shows what exists; sapiom_dev_app_publish creates one.",
  });
}

// ─── Error mapping ───────────────────────────────────────────────────────────

interface CallContext {
  /** What was being attempted, as the subject of the error sentence. */
  action: string;
  /** The permission the route is gated on, named in a refusal. */
  permission: string;
  /** For `_settings`: the fields the caller asked to change. */
  fields?: readonly SettingsField[];
  slug?: string;
}

/**
 * The parsed success body, or a thrown `PreviewOperationError` that says what to
 * change and what state the link is left in. None of these calls creates
 * anything, so every failure can honestly say nothing was changed.
 */
function unwrap(
  res: Awaited<ReturnType<typeof appLinksFetch>>,
  ctx: CallContext,
): unknown {
  if (res.kind === "network") {
    throw new PreviewOperationError({
      code: "NETWORK",
      message: `Could not reach ${res.url}. Nothing was changed.`,
      hint: res.cause instanceof Error ? res.cause.message : String(res.cause),
    });
  }
  if (res.ok) return res.data;
  throw manageError(res.status, res.data, ctx);
}

/**
 * Map a failed call onto a structured error. The permission branches are the
 * point of this module: a 403 comes back as a sentence that names the missing
 * permission and the fields, never as a status the agent might retry.
 */
function manageError(
  status: number,
  data: unknown,
  ctx: CallContext,
): PreviewOperationError {
  const body = (data ?? {}) as ErrorBody;
  const code = codeFrom(data);
  const message = messageFrom(body);
  const fields = ctx.fields?.length ? ctx.fields.join(", ") : undefined;

  if (status === 401) {
    return new PreviewOperationError({
      code: code ?? "NOT_AUTHENTICATED",
      message:
        `The cached credential was rejected (401). ${message ?? ""} Nothing was changed.`
          .replace(/\s+/g, " ")
          .trim(),
      hint: "Run sapiom_authenticate to sign in again.",
    });
  }
  // Two 403 shapes, one answer. The service-level code names the fields it
  // refused (only reachable through the upsert today, kept for when PATCH
  // grows the same gate); the route-level guard says only "Missing required
  // permissions: org.write". Either way the user hears which permission and
  // which fields, not a status code.
  if (status === 403) {
    const isManagementCode = code === "APP_LINK_MANAGEMENT_PERMISSION_REQUIRED";
    return new PreviewOperationError({
      code: isManagementCode ? code : "PERMISSION_REQUIRED",
      message:
        `${ctx.action} requires the \`${ctx.permission}\` permission, which this credential ` +
        `does not hold${fields ? ` (fields: ${fields})` : ""}. Nothing was changed.`,
      hint:
        `Tell the user rather than retrying. An org member with \`${ctx.permission}\` can ` +
        "make this change — from the dashboard's App Links page, with an `org.write` API key " +
        "against the same REST route, or by running sapiom_authenticate here as that member. " +
        "Publish authority (`org.app_links.publish`) can republish the app's code but not change " +
        "how a link is exposed or what it may spend.",
    });
  }
  if (status === 404 || code === "APP_LINK_NOT_FOUND") {
    return notFound(ctx.slug ?? "(that link)");
  }
  if (code === "PUBLIC_CONFIRM_REQUIRED") {
    return new PreviewOperationError({
      code,
      message:
        'visibility "public" means anyone with the link can wake this app and your org pays. Nothing was changed.',
      hint: "Ask the user, then retry with confirmPublic: true and a dailySpendCapUsd.",
    });
  }
  if (code === "PUBLIC_SPEND_CAP_REQUIRED") {
    return new PreviewOperationError({
      code,
      message:
        "A public app must carry a daily spend cap. Nothing was changed.",
      hint: 'Retry with dailySpendCapUsd (e.g. "5.00"), or keep the link org-scoped.',
    });
  }
  return new PreviewOperationError({
    code: code ?? `HTTP_${status}`,
    message: `${message ?? `${ctx.action} failed (${status}).`} Nothing was changed.`,
  });
}

// ─── Reporting ───────────────────────────────────────────────────────────────

function settingsOf(link: AppLinkWire): Record<SettingsField, unknown> {
  return {
    webhooksEnabled: link.webhooksEnabled ?? null,
    visibility: link.visibility,
    dailySpendCapUsd: link.dailySpendCapUsd ?? null,
    wakeRateLimitPerHour: link.wakeRateLimitPerHour ?? null,
  };
}

/** One list row: what an agent needs to pick a link and describe its exposure. */
function describeLink(link: AppLinkWire) {
  const webhooksEnabled = link.webhooksEnabled ?? false;
  return {
    slug: link.slug,
    name: link.name,
    url: link.url,
    appLinkId: link.id,
    visibility: link.visibility,
    webhooksEnabled,
    webhookUrl: webhooksEnabled ? webhookUrlOf(link) : null,
    dailySpendCapUsd: link.dailySpendCapUsd ?? null,
    wakeRateLimitPerHour: link.wakeRateLimitPerHour ?? null,
    wakeStatus: link.wakeStatus ?? null,
    published: link.bundleSha256 != null,
    updatedAt: link.updatedAt ?? null,
  };
}

/** The one-line answer the agent can hand straight to the user. */
function summarizeSettings(
  link: AppLinkWire,
  changed: readonly SettingsField[],
): string {
  const parts: string[] = [];
  if (changed.includes("webhooksEnabled")) {
    parts.push(
      link.webhooksEnabled
        ? `Webhooks are ON: third parties POST to ${webhookUrlOf(link)}<path> (the /hook prefix is ` +
            "stripped before the app sees the path, and the body arrives byte-exact for signature checks)."
        : "Webhooks are OFF: the /hook path no longer accepts requests.",
    );
  }
  if (changed.includes("visibility")) {
    parts.push(
      link.visibility === "public"
        ? "The link is PUBLIC — anyone with the URL can open it and your org pays for each wake."
        : "The link is org-scoped — only logged-in members of your organization can open it.",
    );
  }
  if (changed.includes("dailySpendCapUsd")) {
    parts.push(
      link.dailySpendCapUsd == null
        ? "The daily spend cap is cleared."
        : `The daily spend cap is $${link.dailySpendCapUsd}.`,
    );
  }
  if (changed.includes("wakeRateLimitPerHour")) {
    parts.push(`Wake rate limit: ${link.wakeRateLimitPerHour} per hour.`);
  }
  return `Updated "${link.name}" (${link.url}). ${parts.join(" ")}`;
}
