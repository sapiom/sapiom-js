/**
 * `sapiom_dev_app_publish` — publish the project's sandbox resource as an
 * **App Link**: a durable `https://apps.sapiom.ai/{org}/{slug}` URL that
 * outlives any sandbox.
 *
 * The sibling of `sapiom_dev_sandbox_preview` (sandbox.ts): same `sapiom.json`
 * `type: "sandbox"` resource, same source directory, same `start`/`port`/`build`
 * — different destination. `preview` deploys into a live sandbox whose URL dies
 * with the sandbox's `ttl`; this uploads the source as a stored bundle behind a
 * permanent address, and the hosting layer wakes it on the first visit. Nothing
 * is provisioned here: no gateway call, no sandbox, no Blaxel. The wake happens
 * later, on demand.
 *
 * Three calls against the App Links REST API, in order:
 *   POST /v1/app-links            (upsert on slug)
 *   PUT  /v1/app-links/{id}/bundle
 *   POST /v1/app-links/{id}/publish
 *
 * Auth is the cached `sapiom_authenticate` credential as `x-api-key`.
 *
 * The first call CREATES the link, so a failure in either of the last two
 * leaves a real link with no active bundle. Error copy is step-aware for
 * exactly that reason: only a step-1 failure may claim nothing was created.
 *
 * Bundles are UTF-8 TEXT ONLY and size-capped: the file-map transport decodes
 * everything as text, so a binary would arrive silently corrupted. Both rules
 * are enforced locally, before any HTTP call, with the same
 * `BUNDLE_BINARY_FILE` / `BUNDLE_TOO_LARGE` codes the backend uses — an agent
 * that has to fix its input should never have paid for an upload, or left a
 * half-finished link behind, to learn that.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
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
const BUNDLE_CAP_BYTES = BUNDLE_CAP_MIB * 1024 * 1024;

/**
 * Never bundled at any depth. `node_modules` because dependencies install in
 * the sandbox at wake via `build`; `.git` because history is not app source.
 */
const ALWAYS_SKIP = new Set(["node_modules", ".git"]);

/** Fatal decoder — the point is to REJECT a non-UTF-8 file, never to replace its bytes. */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

// ─── Wire shapes ─────────────────────────────────────────────────────────────

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
      "node_modules, .git, dotfiles, symlinks and the project's own sapiom.json are never uploaded — " +
      "install dependencies at wake via `build`. Both limits are checked locally, so a bad bundle costs no upload. " +
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

        const api = (
          step: PublishStep,
          method: string,
          route: string,
          body: unknown,
        ) =>
          appLinksRequest(
            env.apiURL,
            creds.apiKey,
            input.slug,
            step,
            method,
            route,
            body,
          );

        // In order: upsert → upload bundle → activate.
        const created = await api("create", "POST", "/v1/app-links", {
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
        });
        // The id addresses the next two calls, so a body that is not the link
        // we asked for (a proxy's HTML error page answering 200, say) has to
        // stop here rather than become `/v1/app-links/undefined/bundle`.
        const link = asAppLink(created);

        const bundle = (await api(
          "bundle",
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
        // last uploaded to this link, which is normally the one the PUT above
        // just stored. Normally: another publisher can upload to the same slug
        // between our two calls, in which case the active bundle is theirs.
        const published = asAppLink(
          await api(
            "publish",
            "POST",
            `/v1/app-links/${encodeURIComponent(link.id)}/publish`,
            {},
          ),
        );
        // Report what the backend says is live, and say so when that is not
        // what we uploaded — `manifest` describes OUR bundle, so pairing a
        // foreign sha with it silently would misdescribe the running app.
        const activeSha = published.bundleSha256 ?? bundle.bundleSha256;
        const raced = activeSha !== bundle.bundleSha256;

        return ok({
          summary: summarize(published, bundle, raced),
          url: published.url,
          appLinkId: published.id,
          bundleSha256: activeSha,
          manifest: bundle.manifest,
          ...(raced
            ? {
                warning:
                  `The active bundle is ${activeSha}, not the ${bundle.bundleSha256} this call uploaded — ` +
                  "something else published the same slug in between. `manifest` describes the uploaded " +
                  "bundle, not the live one. Publish again if yours is the one that should be live.",
              }
            : {}),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/** The one-line answer the agent can hand straight to the user. */
function summarize(
  link: AppLinkWire,
  bundle: UploadBundleWire,
  raced: boolean,
): string {
  const audience =
    link.visibility === "public"
      ? "public — anyone with the link"
      : "org members only";
  const files = raced
    ? "a bundle published by something else — see `warning`"
    : `${bundle.manifest.fileCount} files`;
  return (
    `Published "${link.name}" to ${link.url} (${audience}; ${files}). ` +
    `The link is durable — republish the "${link.slug}" slug to update it in place. ` +
    "The first visit after a publish cold-starts the app."
  );
}

/**
 * Narrow a wire body to an app link, or fail loudly. A 200/201 whose body is
 * not JSON (`safeParse` hands back the raw string) or lacks an `id` cannot be
 * used to address the next call.
 */
function asAppLink(data: unknown): AppLinkWire {
  const link = data as AppLinkWire | undefined;
  if (
    typeof link?.id !== "string" ||
    link.id === "" ||
    typeof link.url !== "string"
  ) {
    throw new PreviewOperationError({
      code: "UNEXPECTED_RESPONSE",
      message:
        "The App Links API answered with a success status but not an app link. " +
        "The publish may or may not have taken effect.",
      hint: "Check the SAPIOM_ENVIRONMENT / api URL this MCP is pointed at, then retry.",
    });
  }
  return link;
}

// ─── Bundle collection ───────────────────────────────────────────────────────

/**
 * Walk the resource's source directory into the `{ path: contents }` map the
 * bundle endpoint takes.
 *
 * Not `collectDirFiles` from `@sapiom/tools`: that reads with a lossy `utf8`
 * decode, which turns a binary into U+FFFD soup instead of an error — exactly
 * the corruption `BUNDLE_BINARY_FILE` exists to prevent. Skips (like it does)
 * `node_modules`, `.git`, and dotfiles/dot-dirs, plus the project's own
 * `sapiom.json` AT THE BUNDLE ROOT — that file is project config, not app
 * source, and its `env` block holds the app's own secrets, which a static
 * `start` command would serve to every visitor of a public link. A nested
 * `sapiom.json` deeper in the tree is ordinary app content and is kept.
 *
 * Symlinks are skipped rather than followed. `collectDirFiles` follows them,
 * but its destination is a private sandbox; here the bundle can end up behind a
 * public URL, and a link out of the tree (`report.txt -> ../../secrets`) would
 * publish whatever it points at. A self-referential link would also recurse
 * forever.
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
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new PreviewOperationError({
      code: "NO_SOURCE_DIR",
      message: `Source directory not found: ${root}`,
      hint: `Fix \`source.path\` on the "${cfg.name}" resource in ${CONFIG_FILE}.`,
    });
  }

  const files: Record<string, string> = {};
  const walk = (abs: string, depth: number): void => {
    for (const entry of readdirSync(abs).sort()) {
      if (ALWAYS_SKIP.has(entry) || entry.startsWith(".")) continue;
      if (depth === 0 && entry === CONFIG_FILE) continue;
      const childAbs = path.join(abs, entry);
      const stat = lstatSync(childAbs);
      if (stat.isSymbolicLink()) continue;
      const rel = path.relative(root, childAbs).split(path.sep).join("/");
      if (stat.isDirectory()) {
        walk(childAbs, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      files[rel] = decodeTextFile(childAbs, rel);
    }
  };
  walk(root, 0);

  if (Object.keys(files).length === 0) {
    throw new PreviewOperationError({
      code: "BUNDLE_INVALID",
      message: `No files to publish under ${root}.`,
      hint: "App Link bundles need at least one text file (node_modules, .git, dotfiles and symlinks are skipped).",
    });
  }
  assertUnderCap(files);
  return files;
}

/**
 * Refuse an over-cap bundle locally. Measured exactly as the backend does — the
 * UTF-8 byte length of the canonical `{"files":{…}}` JSON with sorted keys — so
 * this never disagrees with the server it is standing in for. Worth doing before
 * the network: the alternative is uploading megabytes to be told no, having
 * already created the link.
 */
function assertUnderCap(files: Record<string, string>): void {
  const sorted = Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const bytes = Buffer.byteLength(JSON.stringify({ files: sorted }), "utf8");
  if (bytes <= BUNDLE_CAP_BYTES) return;
  throw new PreviewOperationError({
    code: "BUNDLE_TOO_LARGE",
    message:
      `The bundle is ${bytes} bytes, over the ${BUNDLE_CAP_BYTES}-byte (${BUNDLE_CAP_MIB} MiB) limit. ` +
      "Nothing was created or published.",
    step: "collect",
    hint:
      "Drop generated output (dist, build artifacts, lockfiles, vendored assets) from the source " +
      "directory and install or build at wake via the resource's `build` command instead.",
  });
}

/** Read one file as UTF-8, naming it in the error when it is not text. */
function decodeTextFile(abs: string, rel: string): string {
  const bytes = readFileSync(abs);
  try {
    return strictUtf8.decode(bytes);
  } catch (cause) {
    throw new PreviewOperationError({
      code: "BUNDLE_BINARY_FILE",
      message: `"${rel}" is not UTF-8 text, and App Link bundles are text-only. Nothing was created or published.`,
      step: "collect",
      hint:
        `Remove ${rel} from the source directory (or replace it with a text asset — inline SVG, a data URL, ` +
        `a CDN reference), then publish again. Cause: ${cause instanceof Error ? cause.message : String(cause)}.`,
    });
  }
}

// ─── REST transport ──────────────────────────────────────────────────────────

/**
 * Which of the three calls is in flight. The distinction is not cosmetic: step
 * `create` is the only one that can fail without leaving anything behind, so it
 * is the only one whose error copy may say so.
 */
type PublishStep = "create" | "bundle" | "publish";

const STEP_ROUTE: Record<PublishStep, string> = {
  create: "POST /v1/app-links",
  bundle: "PUT /v1/app-links/{id}/bundle",
  publish: "POST /v1/app-links/{id}/publish",
};

/**
 * What the agent must be told about the world after a failure at this step.
 * After `create` succeeds the link exists, so "nothing was published" would be
 * a lie — and an agent that believes it will not go clean up or finish the job.
 */
function aftermath(step: PublishStep, slug: string): string {
  return step === "create"
    ? "Nothing was created or published."
    : `The "${slug}" app link EXISTS but has no new bundle active. Fix the above and publish the same slug again to finish it (or delete the link if you no longer want it).`;
}

/**
 * One JSON call against the backend's App Links REST API, with the wire error
 * codes turned into errors the agent can act on.
 *
 * A bare `GatewayClient` would not do: its mapping keeps only `HTTP_<status>`
 * and drops the body's `code`, and `BUNDLE_BINARY_FILE` / `BUNDLE_TOO_LARGE`
 * carry the detail (`path`, `bytes`) that makes the failure fixable.
 */
async function appLinksRequest(
  apiURL: string,
  apiKey: string,
  slug: string,
  step: PublishStep,
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
      message: `Could not reach ${url}. ${aftermath(step, slug)}`,
      step: STEP_ROUTE[step],
      hint: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const text = await res.text();
  const data = text ? safeParse(text) : undefined;
  if (!res.ok) throw publishError(res.status, data, step, slug);
  return data;
}

interface ErrorBody {
  code?: unknown;
  message?: unknown;
  /** `BUNDLE_BINARY_FILE`: the offending FILE path, not the request URL. */
  path?: unknown;
  bytes?: unknown;
  maxBytes?: unknown;
}

/**
 * Map a failed publish call onto a structured tool error. Every branch says what
 * to change and what state the app link is left in — the agent's next move
 * should never be a blind retry of the identical call.
 */
function publishError(
  status: number,
  data: unknown,
  step: PublishStep,
  slug: string,
): PreviewOperationError {
  const bodyError = (data ?? {}) as ErrorBody;
  const code = typeof bodyError.code === "string" ? bodyError.code : undefined;
  const message = messageFrom(bodyError);
  const where = STEP_ROUTE[step];
  const left = aftermath(step, slug);

  if (code === "BUNDLE_BINARY_FILE") {
    const file = typeof bodyError.path === "string" ? bodyError.path : "a file";
    return new PreviewOperationError({
      code,
      message: `Bundle rejected: "${file}" is not UTF-8 text. App Link bundles are text-only. ${left}`,
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
      message: `Bundle rejected: ${sizes}${left}`,
      step: where,
      hint:
        "Drop generated output (dist, build artifacts, lockfiles, vendored assets) from the source " +
        "directory and install or build at wake via the resource's `build` command instead.",
    });
  }
  if (code === "PUBLIC_CONFIRM_REQUIRED") {
    return new PreviewOperationError({
      code,
      message: `visibility "public" means anyone with the link can wake this app and your org pays. ${left}`,
      step: where,
      hint: "Ask the user, then retry with confirmPublic: true and a dailySpendCapUsd — or omit visibility to keep it org-scoped.",
    });
  }
  if (code === "PUBLIC_SPEND_CAP_REQUIRED") {
    return new PreviewOperationError({
      code,
      message: `A public app must carry a daily spend cap. ${left}`,
      step: where,
      hint: 'Retry with dailySpendCapUsd (e.g. "5.00"), or omit visibility to keep the app org-scoped.',
    });
  }
  if (status === 401) {
    return new PreviewOperationError({
      code: code ?? "NOT_AUTHENTICATED",
      message:
        `The cached credential was rejected (401). ${message ?? ""} ${left}`
          .replace(/\s+/g, " ")
          .trim(),
      step: where,
      hint: "Run sapiom_authenticate to sign in again.",
    });
  }
  // A 403 has two distinct causes, and the fix differs: publish authority may
  // create a link and republish its content, but not re-expose an existing one.
  if (code === "APP_LINK_MANAGEMENT_PERMISSION_REQUIRED") {
    return new PreviewOperationError({
      code,
      message: `${message ?? "Changing how an existing app link is exposed needs more than publish authority."} ${left}`,
      step: where,
      hint:
        "Republish without the management fields (visibility, dailySpendCapUsd) to update the app in " +
        "place, or have someone with `org.write` change them once.",
    });
  }
  if (status === 403) {
    return new PreviewOperationError({
      code: code ?? "FORBIDDEN",
      message: `Publishing was refused (403). ${message ?? ""} ${left}`
        .replace(/\s+/g, " ")
        .trim(),
      step: where,
      hint:
        "This credential is missing the `org.app_links.publish` permission (which `org.write` implies). " +
        "Publish with a credential that holds it, or ask an org admin.",
    });
  }
  return new PreviewOperationError({
    code: code ?? `HTTP_${status}`,
    message: `${message ?? `Request failed (${status}).`} ${left}`,
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
