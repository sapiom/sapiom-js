/**
 * `sapiom_dev_app_publish` — publish the project's sandbox resource as an
 * **App Link**: a durable `https://apps.sapiom.ai/{org}/{slug}` URL that
 * outlives any sandbox.
 *
 * The sibling of `sapiom_dev_sandbox_preview` (sandbox.ts): same `sapiom.json`
 * `type: "sandbox"` resource, same source directory, same `start`/`port`/`build`
 * — different destination. `preview` deploys into a live sandbox whose URL dies
 * with the sandbox's `ttl`; this uploads the source as a stored bundle behind a
 * permanent address and lets app-host wake it on the first visit. Nothing is
 * provisioned here: no gateway call, no sandbox, no Blaxel. The wake happens
 * later, on demand.
 *
 * The three REST calls are `plans/app-links/interfaces.md` §3, in order:
 *   POST /v1/app-links            (upsert on slug)
 *   PUT  /v1/app-links/{id}/bundle
 *   POST /v1/app-links/{id}/publish
 *
 * Auth is the cached `sapiom_authenticate` credential as `x-api-key` — the
 * user's own key, so the `org.app_links.publish` delegation gap that affects
 * workflow per-run `sat_` tokens (SAP-2882) does not apply here.
 *
 * Bundles are UTF-8 TEXT ONLY: the sandbox file-map transport decodes
 * everything as text, so a binary would arrive silently corrupted. This module
 * rejects one by name locally, before any HTTP call, with the same
 * `BUNDLE_BINARY_FILE` code the backend uses — an agent that has to fix its
 * input should never have paid for an upload to learn that.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CONFIG_FILE,
  getSandbox,
  PreviewOperationError,
  type SandboxConfig,
} from "@sapiom/sandbox-preview";
import { z } from "zod";

import { readCredentials, type ResolvedEnvironment } from "../credentials.js";
import { registerTool } from "../register-tool.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Same shape as the backend's `APP_LINK_SLUG_PATTERN` (app-links.types.ts). */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Same shape as the backend's `USD_DECIMAL_PATTERN`. */
const USD_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;

/** The REST bundle cap (`MAX_BUNDLE_BYTES`), quoted in the tool description. */
const BUNDLE_CAP_MIB = 10;

/**
 * Never bundled. `node_modules` because dependencies install in the sandbox at
 * wake via `build`; `sapiom.json` because it is project config rather than app
 * source and its `env` block holds the app's own secrets — a static `start`
 * command would serve them to every visitor of a public link.
 */
const ALWAYS_SKIP = new Set(["node_modules", ".git", CONFIG_FILE]);

/** Fatal decoder — the point is to REJECT a non-UTF-8 file, never to replace its bytes. */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

// ─── Wire shapes (interfaces §1, §3) ─────────────────────────────────────────

interface AppLinkManifest {
  start: string;
  port: number;
  build?: string;
  envKeys: string[];
  fileCount: number;
  bytes: number;
}

interface AppLinkWire {
  id: string;
  slug: string;
  name: string;
  visibility: string;
  url: string;
  /** Null until a bundle is activated; set on the publish response. */
  bundleSha256?: string | null;
}

interface UploadBundleWire {
  bundleSha256: string;
  manifest: AppLinkManifest;
}

// ─── Registration ────────────────────────────────────────────────────────────

export function register(server: McpServer, env: ResolvedEnvironment): void {
  registerTool(
    server,
    "sapiom_dev_app_publish",
    "Publish this project's web app to a DURABLE Sapiom link: https://apps.sapiom.ai/{org}/{slug}. " +
      "Use this — not sapiom_dev_sandbox_preview — whenever the user wants a link that is permanent, " +
      "shareable, or safe to hand to a teammate: a sandbox preview URL expires with the sandbox's ttl, " +
      'an App Link does not. Reads the same sapiom.json `type: "sandbox"` resource (source dir, start, ' +
      "port, optional build/env), uploads the source as a stored bundle, and activates it. Nothing runs " +
      "until someone visits: the first visit after a publish cold-starts the app (tens of seconds behind " +
      'a "Starting…" page), so this is wake-on-demand hosting, not always-on. Org-scoped by default ' +
      '(only logged-in members of your organization can open it); visibility "public" needs ' +
      "confirmPublic: true and a dailySpendCapUsd because your org pays for every wake. Publishing the " +
      "same slug again replaces the app in place at the SAME URL — that is how you ship an update. " +
      `Bundles are TEXT-ONLY (UTF-8 files; no images, fonts, or archives) and capped at ${BUNDLE_CAP_MIB} MiB; ` +
      "node_modules, .git, dotfiles and sapiom.json are never uploaded — install dependencies at wake via `build`. " +
      "Returns { url, appLinkId, bundleSha256, manifest }.",
    {
      dir: z
        .string()
        .optional()
        .describe(
          "Project directory containing sapiom.json (defaults to the current working directory).",
        ),
      slug: z
        .string()
        .regex(
          SLUG_PATTERN,
          "slug must match [a-z0-9-]{1,63} and start with a letter or digit",
        )
        .describe(
          "URL path segment, unique within your organization — the stable identity of the app. " +
            "Republishing the same slug updates the same URL in place.",
        ),
      name: z
        .string()
        .min(1)
        .max(255)
        .describe(
          'Human-readable app name, shown on the "Starting …" page while it wakes.',
        ),
      resource: z
        .string()
        .optional()
        .describe(
          "Which sapiom.json sandbox resource to publish, when the project defines more than one. " +
            "Omit when there is exactly one.",
        ),
      description: z
        .string()
        .max(2000)
        .optional()
        .describe("Optional description of the app."),
      visibility: z
        .enum(["organization", "public"])
        .optional()
        .describe(
          '"organization" (default: members only) or "public" (anyone with the link; requires ' +
            "confirmPublic and dailySpendCapUsd).",
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
        .optional()
        .describe(
          'Daily spend ceiling for a public app, as a decimal USD string (e.g. "5.00"). ' +
            'Required with visibility "public".',
        ),
    },
    async ({ dir, resource, ...input }) => {
      const creds = await readCredentials(env.name);
      if (!creds) return NOT_AUTHED;
      try {
        const projectDir = dir ?? process.cwd();
        const cfg = getSandbox(projectDir, resource);
        // Collected (and binary-checked) before the first HTTP call, so a bad
        // file map costs no round trip and creates no half-published link.
        const files = collectBundleFiles(projectDir, cfg);

        const api = (method: string, route: string, body: unknown) =>
          appLinksRequest(env.apiURL, creds.apiKey, method, route, body);

        // interfaces §3 order: upsert → upload bundle → activate.
        const link = (await api("POST", "/v1/app-links", {
          slug: input.slug,
          name: input.name,
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
          ...(input.visibility === undefined
            ? {}
            : { visibility: input.visibility }),
          ...(input.confirmPublic === undefined
            ? {}
            : { confirmPublic: input.confirmPublic }),
          ...(input.dailySpendCapUsd === undefined
            ? {}
            : { dailySpendCapUsd: input.dailySpendCapUsd }),
          // The sandbox resource's env travels with the app; stored encrypted,
          // read back as key names only. Its `tier`/`ttl` deliberately do NOT:
          // an App Link's sandbox lifetime is an implementation detail of the
          // wake, and the whole point of publishing is to stop caring about it.
          ...(cfg.env === undefined ? {} : { env: cfg.env }),
        })) as AppLinkWire;

        const bundle = (await api(
          "PUT",
          `/v1/app-links/${encodeURIComponent(link.id)}/bundle`,
          {
            files,
            start: cfg.start,
            port: cfg.port,
            ...(cfg.build === undefined ? {} : { build: cfg.build }),
          },
        )) as UploadBundleWire;

        // Activate. The route takes NO body — it activates whatever bundle was
        // last uploaded to this link, which is the one the PUT above just
        // stored. The response echoes the active `bundleSha256`, so a mismatch
        // (another publisher raced us onto the same slug) is visible rather
        // than silently reported as ours.
        const published = (await api(
          "POST",
          `/v1/app-links/${encodeURIComponent(link.id)}/publish`,
          {},
        )) as AppLinkWire;
        const activeSha = published.bundleSha256 ?? bundle.bundleSha256;

        return ok({
          summary: summarize(published, bundle),
          url: published.url,
          appLinkId: published.id,
          bundleSha256: activeSha,
          manifest: bundle.manifest,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/** The one-line answer the agent can hand straight to the user. */
function summarize(link: AppLinkWire, bundle: UploadBundleWire): string {
  const audience =
    link.visibility === "public"
      ? "public — anyone with the link"
      : "org members only";
  return (
    `Published "${link.name}" to ${link.url} (${audience}; ${bundle.manifest.fileCount} files). ` +
    `The link is durable — republish the "${link.slug}" slug to update it in place. ` +
    "The first visit after a publish cold-starts the app."
  );
}

// ─── Bundle collection ───────────────────────────────────────────────────────

/**
 * Walk the resource's source directory into the `{ path: contents }` map the
 * bundle endpoint takes.
 *
 * Not `collectDirFiles` from `@sapiom/tools`: that reads with a lossy `utf8`
 * decode, which turns a binary into U+FFFD soup instead of an error — exactly
 * the corruption `BUNDLE_BINARY_FILE` exists to prevent. Skips (like it does)
 * `node_modules`, `.git`, and dotfiles/dot-dirs, plus `sapiom.json`.
 *
 * A `git`-source resource is read from the same local working tree: the bundle
 * store takes a file map, so there is nothing for a server-side checkout to do.
 */
export function collectBundleFiles(
  projectDir: string,
  cfg: SandboxConfig,
): Record<string, string> {
  const sub = cfg.source.path ?? ".";
  const root = path.resolve(projectDir, sub);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new PreviewOperationError({
      code: "NO_SOURCE_DIR",
      message: `Source directory not found: ${root}`,
      hint: `Fix \`source.path\` on the "${cfg.name}" resource in ${CONFIG_FILE}.`,
    });
  }

  const files: Record<string, string> = {};
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs).sort()) {
      if (ALWAYS_SKIP.has(entry) || entry.startsWith(".")) continue;
      const childAbs = path.join(abs, entry);
      const rel = path.relative(root, childAbs).split(path.sep).join("/");
      if (statSync(childAbs).isDirectory()) {
        walk(childAbs);
        continue;
      }
      files[rel] = decodeTextFile(childAbs, rel);
    }
  };
  walk(root);

  if (Object.keys(files).length === 0) {
    throw new PreviewOperationError({
      code: "BUNDLE_INVALID",
      message: `No files to publish under ${root}.`,
      hint: "App Link bundles need at least one text file (node_modules, .git and dotfiles are skipped).",
    });
  }
  return files;
}

/** Read one file as UTF-8, naming it in the error when it is not text. */
function decodeTextFile(abs: string, rel: string): string {
  const bytes = readFileSync(abs);
  try {
    return strictUtf8.decode(bytes);
  } catch (cause) {
    throw new PreviewOperationError({
      code: "BUNDLE_BINARY_FILE",
      message: `"${rel}" is not UTF-8 text, and App Link bundles are text-only. Nothing was published.`,
      step: "collect",
      hint:
        `Remove ${rel} from the source directory (or replace it with a text asset — inline SVG, a data URL, ` +
        `a CDN reference), then publish again. Cause: ${cause instanceof Error ? cause.message : String(cause)}.`,
    });
  }
}

// ─── REST transport ──────────────────────────────────────────────────────────

/**
 * One JSON call against the backend's App Links REST API, with the wire error
 * codes of interfaces §3 turned into errors the agent can act on.
 *
 * A bare `GatewayClient` would not do: its mapping keeps only `HTTP_<status>`
 * and drops the body's `code`, and `BUNDLE_BINARY_FILE` / `BUNDLE_TOO_LARGE`
 * carry the detail (`path`, `bytes`) that makes the failure fixable.
 */
async function appLinksRequest(
  apiURL: string,
  apiKey: string,
  method: string,
  route: string,
  body: unknown,
): Promise<unknown> {
  // Concatenated, not `new URL(route, base)`: a custom `apiURL` carrying a base
  // path (a local proxy, a tunnel) would have it silently dropped by the latter.
  const url = `${apiURL.replace(/\/+$/, "")}${route}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new PreviewOperationError({
      code: "NETWORK",
      message: `Could not reach ${url}.`,
      hint: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const text = await res.text();
  const data = text ? safeParse(text) : undefined;
  if (!res.ok) throw publishError(res.status, data, `${method} ${route}`);
  return data;
}

interface ErrorBody {
  code?: unknown;
  message?: unknown;
  /** `BUNDLE_BINARY_FILE`: the offending FILE path (interfaces §2). */
  path?: unknown;
  bytes?: unknown;
  maxBytes?: unknown;
}

/**
 * Map a failed publish call onto a structured tool error. Every branch says what
 * to change and that nothing was published — the agent's next move should never
 * be a blind retry of the identical call.
 */
function publishError(
  status: number,
  data: unknown,
  where: string,
): PreviewOperationError {
  const bodyError = (data ?? {}) as ErrorBody;
  const code = typeof bodyError.code === "string" ? bodyError.code : undefined;
  const message = messageFrom(bodyError);

  if (code === "BUNDLE_BINARY_FILE") {
    const file = typeof bodyError.path === "string" ? bodyError.path : "a file";
    return new PreviewOperationError({
      code,
      message: `Bundle rejected: "${file}" is not UTF-8 text. App Link bundles are text-only. Nothing was published.`,
      step: where,
      hint: `Remove ${file} (or replace it with a text asset — inline SVG, a data URL, a CDN reference) and publish again.`,
    });
  }
  if (code === "BUNDLE_TOO_LARGE") {
    const sizes =
      typeof bodyError.bytes === "number" &&
      typeof bodyError.maxBytes === "number"
        ? `${bodyError.bytes} bytes exceeds the ${bodyError.maxBytes}-byte limit. `
        : "";
    return new PreviewOperationError({
      code,
      message: `Bundle rejected: ${sizes}Nothing was published.`,
      step: where,
      hint:
        "Drop generated output (dist, build artifacts, lockfiles, vendored assets) from the source " +
        "directory and install or build at wake via the resource's `build` command instead.",
    });
  }
  if (code === "PUBLIC_CONFIRM_REQUIRED") {
    return new PreviewOperationError({
      code,
      message:
        'visibility "public" means anyone with the link can wake this app and your org pays. Nothing was published.',
      step: where,
      hint: "Ask the user, then retry with confirmPublic: true and a dailySpendCapUsd — or omit visibility to keep it org-scoped.",
    });
  }
  if (code === "PUBLIC_SPEND_CAP_REQUIRED") {
    return new PreviewOperationError({
      code,
      message:
        "A public app must carry a daily spend cap. Nothing was published.",
      step: where,
      hint: 'Retry with dailySpendCapUsd (e.g. "5.00"), or omit visibility to keep the app org-scoped.',
    });
  }
  if (status === 401) {
    return new PreviewOperationError({
      code: code ?? "NOT_AUTHENTICATED",
      message:
        `The cached credential was rejected (401). ${message ?? ""}`.trim(),
      step: where,
      hint: "Run sapiom_authenticate to sign in again.",
    });
  }
  // A 403 has two distinct causes, and the fix differs: publish authority may
  // create a link and republish its content, but not re-expose an existing one.
  if (code === "APP_LINK_MANAGEMENT_PERMISSION_REQUIRED") {
    return new PreviewOperationError({
      code,
      message: `${message ?? "Changing how an existing app link is exposed needs more than publish authority."} Nothing was published.`,
      step: where,
      hint:
        "Republish without the management fields (visibility, dailySpendCapUsd) to update the app in " +
        "place, or have someone with `org.write` change them once.",
    });
  }
  if (status === 403) {
    return new PreviewOperationError({
      code: code ?? "FORBIDDEN",
      message: `Publishing was refused (403). ${message ?? ""}`.trim(),
      step: where,
      hint:
        "This credential is missing the `org.app_links.publish` permission (which `org.write` implies). " +
        "Publish with a credential that holds it, or ask an org admin.",
    });
  }
  return new PreviewOperationError({
    code: code ?? `HTTP_${status}`,
    message:
      message ??
      `Request failed (${status}). Nothing was published at ${where}.`,
    step: where,
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function messageFrom(body: ErrorBody): string | undefined {
  const m = body.message;
  if (Array.isArray(m)) return m.join("; ");
  if (typeof m === "string") return m;
  return undefined;
}

// ─── Result envelope ─────────────────────────────────────────────────────────

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * The structured `{"error": {code, message, hint?}}` envelope. The JSON matters
 * beyond readability: `registerTool` parses `error.code` out of it to classify
 * the `tool.call` analytics event.
 */
function fail(err: unknown): ToolResult {
  const structured =
    err instanceof PreviewOperationError
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

const NOT_AUTHED = fail(
  new PreviewOperationError({
    code: "NOT_AUTHENTICATED",
    message: "Not authenticated. Run sapiom_authenticate first.",
  }),
);
