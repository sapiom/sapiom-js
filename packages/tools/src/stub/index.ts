/**
 * `@sapiom/tools/stub` — a stub capability client for local development.
 *
 * `createStubClient()` returns a `Sapiom` of the same shape as the real client,
 * but every capability is satisfied by a built-in default (so a workflow runs
 * locally with zero setup) plus optional per-capability overrides (when a step's
 * logic branches on a result). No network, no credentials.
 *
 * It is shape-faithful: namespace methods return the real handle types
 * (`Repository`, `Sandbox`, `RunHandle`), and a handle's instance methods
 * (`repo.pushFromSandbox(...)`, `sandbox.exec(...)`) work too — so a step never
 * has to be rewritten to run locally. Method names are validated against the
 * real handle classes, so a call to a method that doesn't exist throws.
 *
 * Overrides are keyed by capability path — namespace methods by their dotted
 * path (`repositories.list`, `models.coding.run`), handle methods by
 * `<handle>.<method>` (`repository.pushFromSandbox`, `sandbox.exec`). A value
 * replaces that capability's default; a function `(…args) => value` computes it
 * from the call arguments.
 */
import {
  MODEL_RUN_RESULT_SIGNAL,
  CODING_RESULT_SIGNAL,
  toResumePayload,
} from "../models/index.js";
import type {
  ModelRunHandle,
  ModelRunResult,
  CodingRunResult,
  RunHandle,
  RunStatus,
} from "../models/index.js";
import { AGENTS_RESULT_SIGNAL } from "../agents/index.js";
import type {
  AgentRunResult,
  RunHandle as AgentRunHandle,
} from "../agents/index.js";
import type { Sapiom } from "../client.js";
import { Repository } from "../repositories/index.js";
import { Sandbox } from "../sandboxes/index.js";
import type { SandboxInfo } from "../sandboxes/index.js";
import type {
  UploadResponse,
  DownloadUrlResponse,
  ListResponse,
  FileMetadata,
} from "../file-storage/index.js";
import {
  VIDEO_RESULT_SIGNAL,
  toVideoResumePayload,
} from "../content-generation/index.js";
import type {
  ImageGenerationResult,
  VideoGenerationResult,
  VideoLaunchHandle,
} from "../content-generation/index.js";
import type {
  ScrapeResult,
  WebSearchResponse,
  FindEmailResult,
  VerifyEmailResult,
  DomainSearchResult,
} from "../search/index.js";
import type { Database } from "../database/index.js";
import type {
  Inbox,
  InboxList,
  SendResult,
  MessageList,
  Message,
  ThreadList,
  Thread,
  Domain,
  DomainList,
  Webhook,
} from "../email/index.js";
import type {
  DomainAvailability,
  Domain as OwnedDomain,
  DomainTransfer,
  DnsRecord,
} from "../domains/index.js";
import type {
  AppendResult,
  RecallResponse,
  MemorySweepResponse,
  Memory,
  MemoryCallOptions,
} from "../memory/index.js";

/** Per-capability overrides, keyed by capability path (see module docs). */
export type StubOverrides = Record<
  string,
  unknown | ((...args: unknown[]) => unknown)
>;

export interface StubClientOptions {
  overrides?: StubOverrides;
  /**
   * When provided, any dispatch-able capability records `(correlationId →
   * result)` here (via {@link dispatchable}). A local runner uses it to
   * auto-resume a `pauseUntilSignal(handle, …)` with the result the handle's
   * signal would have carried.
   */
  signals?: Map<string, unknown>;
  /**
   * When provided, every override key that is actually matched by a capability
   * call is added here. A local runner diffs this against the keys the author
   * supplied to warn about stub keys that matched nothing (a typo'd path, or the
   * wrong plural/singular form) — which otherwise fail silently.
   */
  usedKeys?: Set<string>;
  /**
   * When provided, collects human-readable warnings about stub *values* that are
   * present but malformed for the capability they override (e.g. a
   * `repositories.list` stub that isn't an array of repositories). Catches the
   * silent-wrong-data trap that `usedKeys` can't — a key that matched but carried
   * the wrong shape.
   */
  warnings?: Set<string>;
}

// Module-scoped so correlation ids are unique across launches within a run.
let launchSeq = 0;

/** A launched, pausable capability handle (the `DispatchHandle` shape). */
function isDispatchHandle(
  v: unknown,
): v is { dispatch: { correlationId: string }; wait: () => Promise<unknown> } {
  if (!v || typeof v !== "object") return false;
  const h = v as { dispatch?: { correlationId?: unknown }; wait?: unknown };
  return (
    typeof h.wait === "function" &&
    typeof h.dispatch?.correlationId === "string"
  );
}

/**
 * Register a dispatch-able handle's eventual result so a pause on its signal can
 * be auto-resumed, then return the handle. Capability-agnostic: any launch-style
 * stub method wraps its returned handle in this — the result a `pauseUntilSignal`
 * resumes with is exactly what the handle's `wait()` resolves to.
 */
async function dispatchable<T>(
  handle: T,
  signals?: Map<string, unknown>,
  resumePayload?: () => unknown | Promise<unknown>,
): Promise<T> {
  if (signals && isDispatchHandle(handle)) {
    // The resume payload crosses a wire boundary — it reaches the resumed step as
    // plain JSON, never a live handle. A capability may supply `resumePayload` to
    // produce that wire shape; absent, the awaited result IS the payload. Round-trip
    // it either way so a local run sees exactly the wire shape — no local-only
    // handle methods to lean on.
    const payload = resumePayload ? await resumePayload() : await handle.wait();
    signals.set(handle.dispatch.correlationId, toPlainJson(payload));
  }
  return handle;
}

/** Deep-plainify a value the way a wire boundary would (drops handle behavior). */
function toPlainJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

// Method names of each handle, reflected from the real classes so the stub stays
// in lockstep with the SDK (a renamed/added method is picked up automatically).
const REPOSITORY_METHODS = handleMethods(Repository.prototype);
const SANDBOX_METHODS = handleMethods(Sandbox.prototype);
const RUN_HANDLE_METHODS = new Set(["status", "wait"]); // RunHandle is a literal, not a class

function handleMethods(proto: object): Set<string> {
  return new Set(
    Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor"),
  );
}

/**
 * Resolve an override for a capability call. `paths` is one path or an ordered
 * list of candidates — the first that is present wins, so a dispatched method can
 * honor both its own key and the shared result key (see {@link dispatchedKeys}).
 * Only the candidate that actually matches is consulted (and thus recorded as
 * used), so unmatched-key reporting stays precise.
 */
function resolve(
  overrides: StubOverrides,
  paths: string | string[],
  args: unknown[],
  fallback: () => unknown,
): unknown {
  for (const path of typeof paths === "string" ? [paths] : paths) {
    if (Object.prototype.hasOwnProperty.call(overrides, path)) {
      const o = overrides[path];
      return typeof o === "function"
        ? (o as (...a: unknown[]) => unknown)(...args)
        : o;
    }
  }
  return fallback();
}

/**
 * The stub keys a dispatched capability accepts, in precedence order: the
 * method actually called (`<ns>.launch`) wins, then the shared blocking-result
 * key (`<ns>.run`) that produces the same payload. Lets an author stub the key
 * matching the call they wrote — `models.coding.launch` — while the canonical
 * `models.coding.run` keeps working for both `run()` and `launch()`. Uniform
 * across the dispatchable/pause family (coding today; deep research,
 * sub-workflows, browser sessions later).
 */
function dispatchedKeys(namespace: string): string[] {
  return [`${namespace}.launch`, `${namespace}.run`];
}

/**
 * Wrap an overrides object so that every present key `resolve` consults is
 * recorded in `used` (via the `hasOwnProperty` probe → `getOwnPropertyDescriptor`
 * trap). Lets a runner report supplied-but-unmatched stub keys without threading
 * a tracker through every factory.
 */
function recordingOverrides(
  raw: StubOverrides,
  used?: Set<string>,
): StubOverrides {
  if (!used) return raw;
  return new Proxy(raw, {
    getOwnPropertyDescriptor(target, prop) {
      const desc = Object.getOwnPropertyDescriptor(target, prop);
      if (desc && typeof prop === "string") used.add(prop);
      return desc;
    },
  });
}

/** Coerce a resolved value (override or default; plain JSON or an existing stub
 *  handle) into a Repository handle, so stubbing a handle-returning capability
 *  with plain JSON never strips the handle's instance methods. */
function asRepository(data: unknown, overrides: StubOverrides): Repository {
  const d = (data ?? {}) as {
    slug?: string;
    cloneUrl?: string;
    status?: string;
  };
  const slug = d.slug ?? "stub-repo";
  return stubRepository(
    {
      slug,
      cloneUrl: d.cloneUrl ?? `https://git.local/${slug}.git`,
      status: d.status,
    },
    overrides,
  );
}

/** Sandbox counterpart to {@link asRepository}. */
function asSandbox(data: unknown, overrides: StubOverrides): Sandbox {
  const d = (data ?? {}) as { name?: string; workspaceRoot?: string };
  return stubSandbox(
    { name: d.name ?? "stub-sandbox", workspaceRoot: d.workspaceRoot },
    overrides,
  );
}

/** Default read-model for the `sandboxes.get` / `sandboxes.list` stubs. */
function stubSandboxInfo(name: string): SandboxInfo {
  return {
    name,
    source: "stub",
    status: "running",
    tier: "s",
    url: null,
    workspaceRoot: "/workspace",
    expiresAt: null,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

/** Coerce a `repositories.list` override (or default) into Repository handles,
 *  warning when the value or an element is the wrong shape — so a malformed list
 *  stub surfaces instead of silently yielding repos with `slug: undefined`. */
function asRepositoryList(
  data: unknown,
  overrides: StubOverrides,
  warnings?: Set<string>,
): Repository[] {
  if (!Array.isArray(data)) {
    warnings?.add(
      `'repositories.list' stub must be an array of repositories (e.g. [{ "slug": "...", "cloneUrl": "..." }]); ` +
        `got ${describeShape(data)}. Returning an empty list.`,
    );
    return [];
  }
  return data.map((el, i) => {
    if (
      !el ||
      typeof el !== "object" ||
      typeof (el as { slug?: unknown }).slug !== "string"
    ) {
      warnings?.add(
        `'repositories.list'[${i}] is not a repository shape (expected { slug, cloneUrl }); got ${describeShape(el)}. ` +
          `Note: stub values are NOT consumed one-per-call — a list stub is the array list() returns, so write ` +
          `[{ "slug": "..." }], not [[{ ... }]].`,
      );
    }
    return asRepository(el, overrides);
  });
}

function describeShape(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `an array (length ${v.length})`;
  return typeof v;
}

/**
 * Build a handle proxy: data fields read from `data`; declared methods resolve an
 * override (`<type>.<method>`) or a default; any other property is rejected as
 * not part of the handle.
 */
function makeHandle(
  type: "repository" | "sandbox" | "runHandle",
  methods: Set<string>,
  data: Record<string, unknown>,
  overrides: StubOverrides,
  defaults: Record<string, (args: unknown[]) => unknown>,
): unknown {
  return new Proxy(data, {
    get(target, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      const key = String(prop);
      if (key in target) return target[key]; // data field (incl. nested handles)
      // Serialization / coercion hooks: a stub handle must survive being
      // JSON.stringify'd, logged, or string-coerced — these flow through the
      // local runner's trace, `ctx.shared` snapshots, and the resume payload. We
      // answer them with the handle's plain data instead of letting the
      // unknown-property guard below throw (which surfaced as the opaque
      // "'sandbox.toJSON' is not a method or field" failure). `{ ...target }`
      // copies only the data fields; nested handles serialize via their own
      // toJSON in turn.
      if (key === "toJSON") return () => ({ ...target });
      if (key === "toString") return () => `[stub ${type}]`;
      if (key === "valueOf") return () => target;
      if (methods.has(key)) {
        return (...args: unknown[]): Promise<unknown> =>
          Promise.resolve(
            resolve(overrides, `${type}.${key}`, args, () =>
              defaults[key]?.(args),
            ),
          );
      }
      throw new Error(
        `'${type}.${key}' is not a method or field on this handle.`,
      );
    },
  });
}

const REPO_METHOD_DEFAULTS: Record<string, (args: unknown[]) => unknown> = {
  delete: () => undefined,
  pushFromSandbox: () => ({
    pushed: true,
    sha: "stub00000000",
    branch: "main",
  }),
};

const SANDBOX_METHOD_DEFAULTS: Record<string, (args: unknown[]) => unknown> = {
  exec: () => ({ pid: "stub-proc", exitCode: 0, stdout: "", stderr: "" }),
  readFile: () => "",
  writeFile: () => undefined,
  destroy: () => undefined,
};

function stubRepository(
  data: { slug: string; cloneUrl: string; status?: string },
  overrides: StubOverrides,
): Repository {
  return makeHandle(
    "repository",
    REPOSITORY_METHODS,
    {
      slug: data.slug,
      cloneUrl: data.cloneUrl,
      status: data.status ?? "active",
    },
    overrides,
    REPO_METHOD_DEFAULTS,
  ) as Repository;
}

function stubSandbox(
  data: { name: string; workspaceRoot?: string },
  overrides: StubOverrides,
): Sandbox {
  return makeHandle(
    "sandbox",
    SANDBOX_METHODS,
    { name: data.name, workspaceRoot: data.workspaceRoot ?? "/workspace" },
    overrides,
    SANDBOX_METHOD_DEFAULTS,
  ) as Sandbox;
}

function stubCodingResult(overrides: StubOverrides): CodingRunResult {
  return {
    runId: "stub-run",
    status: "completed" as RunStatus,
    summary: "(stub) coding run completed locally",
    result: {
      success: true,
      turns: 1,
      modelUsed: "stub-model",
      durationMs: 0,
      toolCallCount: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        thinkingTokens: 0,
      },
    },
    error: null,
    sandbox: stubSandbox({ name: "stub-sandbox" }, overrides),
  };
}

function stubRunHandle(
  overrides: StubOverrides,
  correlationId: string,
  result: CodingRunResult,
): RunHandle {
  const handle = {
    runId: correlationId,
    sandbox: result.sandbox,
    dispatch: { correlationId, resultSignal: CODING_RESULT_SIGNAL },
    status: () => Promise.resolve(result.status),
    wait: () => Promise.resolve(result),
  };
  return makeHandle(
    "runHandle",
    RUN_HANDLE_METHODS,
    handle as unknown as Record<string, unknown>,
    overrides,
    {},
  ) as RunHandle;
}

function stubAgentResult(): ModelRunResult {
  return {
    runId: "stub-run",
    status: "completed",
    output: "(stub) agent run completed locally",
    result: {
      success: true,
      stopReason: "end_turn",
      turns: 1,
      modelUsed: "stub-model",
      durationMs: 0,
      costUsd: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        thinkingTokens: 0,
      },
    },
    error: null,
  };
}

function stubModelRunHandle(
  overrides: StubOverrides,
  correlationId: string,
  result: ModelRunResult,
): ModelRunHandle {
  const handle = {
    runId: correlationId,
    dispatch: { correlationId, resultSignal: MODEL_RUN_RESULT_SIGNAL },
    status: () => Promise.resolve(result.status),
    wait: () => Promise.resolve(result),
  };
  return makeHandle(
    "runHandle",
    RUN_HANDLE_METHODS,
    handle as unknown as Record<string, unknown>,
    overrides,
    {},
  ) as ModelRunHandle;
}

/**
 * Create a stub `Sapiom` client. Runs every capability against built-in defaults;
 * pass `overrides` to control the results a step branches on.
 */
export function createStubClient(opts: StubClientOptions = {}): Sapiom {
  // Record which override keys actually match a call, so the runner can flag
  // supplied-but-unmatched keys (typos / wrong plural-singular form).
  const overrides = recordingOverrides(opts.overrides ?? {}, opts.usedKeys);
  const r = (
    paths: string | string[],
    args: unknown[],
    fallback: () => unknown,
  ) => resolve(overrides, paths, args, fallback);

  // Resolve a coding run result, then re-wrap its `sandbox` as a handle so the
  // blocking `run()` path keeps a method-capable Sandbox even when the result was
  // overridden with plain JSON. `keys` lets `launch()` accept `models.coding.launch`
  // (the call the author wrote) as well as the shared `models.coding.run`.
  const resolveCodingResult = (
    spec: unknown,
    keys: string | string[],
  ): CodingRunResult => {
    const res = r(keys, [spec], () =>
      stubCodingResult(overrides),
    ) as CodingRunResult;
    return { ...res, sandbox: asSandbox(res.sandbox, overrides) };
  };

  // Default (instant) agent result — no sandbox to re-wrap, so it's the resolved
  // value as-is. `keys` lets `launch()` accept `models.launch` and `models.run`.
  const resolveModelResult = (
    spec: unknown,
    keys: string | string[],
  ): ModelRunResult =>
    r(keys, [spec], () => stubAgentResult()) as ModelRunResult;

  const client: Sapiom = {
    sandboxes: {
      create: (sandboxOpts) =>
        Promise.resolve(
          asSandbox(
            r("sandboxes.create", [sandboxOpts], () => ({
              name: sandboxOpts?.name ?? "stub-sandbox",
            })),
            overrides,
          ),
        ),
      attach: (name, attachOpts) =>
        asSandbox(
          r("sandboxes.attach", [name, attachOpts], () => ({ name })),
          overrides,
        ),
      get: (name, getOpts) =>
        Promise.resolve(
          r("sandboxes.get", [name, getOpts], () =>
            stubSandboxInfo(name),
          ) as SandboxInfo,
        ),
      list: (listOpts) =>
        Promise.resolve(
          r("sandboxes.list", [listOpts], () => [
            stubSandboxInfo("stub-sandbox"),
          ]) as SandboxInfo[],
        ),
    },
    repositories: {
      create: (slug) =>
        Promise.resolve(
          asRepository(
            r("repositories.create", [slug], () => ({ slug })),
            overrides,
          ),
        ),
      get: (slug) =>
        Promise.resolve(
          asRepository(
            r("repositories.get", [slug], () => ({ slug })),
            overrides,
          ),
        ),
      list: () =>
        Promise.resolve(
          asRepositoryList(
            r("repositories.list", [], () => []),
            overrides,
            opts.warnings,
          ),
        ),
      delete: (slug) =>
        Promise.resolve(
          r("repositories.delete", [slug], () => undefined) as void,
        ),
      attach: (slug, cloneUrl) =>
        asRepository(
          r("repositories.attach", [slug, cloneUrl], () => ({
            slug,
            cloneUrl,
          })),
          overrides,
        ),
    },
    models: {
      run: (spec) => Promise.resolve(resolveModelResult(spec, "models.run")),
      launch: (spec) => {
        const correlationId = `stub-run-${++launchSeq}`;
        // `launch()` honors `models.launch` first, then the shared `models.run`.
        const result = {
          ...resolveModelResult(spec, dispatchedKeys("agent")),
          runId: correlationId,
        };
        // The resume payload IS the result (no live handles to strip).
        return dispatchable(
          stubModelRunHandle(overrides, correlationId, result),
          opts.signals,
          () => result,
        );
      },
      coding: {
        run: (spec) =>
          Promise.resolve(resolveCodingResult(spec, "models.coding.run")),
        launch: (spec) => {
          const correlationId = `stub-run-${++launchSeq}`;
          // `launch()` honors the key matching the call the author wrote
          // (`models.coding.launch`) first, then the shared `models.coding.run`
          // that controls both paths.
          const result = {
            ...resolveCodingResult(spec, dispatchedKeys("models.coding")),
            runId: correlationId,
          };
          // Register for pause-resume with the wire shape a resumed step receives:
          // `toResumePayload` maps the live result to a `CodingResultPayload` (an
          // `executionEnvironment` reference, not a live sandbox handle).
          return dispatchable(
            stubRunHandle(overrides, correlationId, result),
            opts.signals,
            () => toResumePayload(result),
          );
        },
      },
    },
    agents: {
      run: (spec) =>
        Promise.resolve(
          r("agents.run", [spec], () => ({
            executionId: `stub-exec-${++launchSeq}`,
            status: "completed" as const,
            output: {},
            error: null,
          })) as AgentRunResult,
        ),
      launch: (spec) => {
        const executionId = `stub-exec-${++launchSeq}`;
        const result: AgentRunResult = {
          executionId,
          status: "completed",
          output: {},
          error: null,
        };
        const handle: AgentRunHandle = {
          executionId,
          dispatch: {
            correlationId: executionId,
            resultSignal: AGENTS_RESULT_SIGNAL,
          },
          status: () => Promise.resolve("completed" as const),
          wait: () => Promise.resolve(result),
        };
        // Register the resume payload so a local `pauseUntilSignal` on this handle
        // resolves with an AgentRunResultPayload.
        return dispatchable(handle, opts.signals, () => ({
          status: "completed" as const,
          executionId,
          definition: spec.definition,
          version: "stub",
          output: {},
          startedAt: "2099-01-01T00:00:00.000Z",
          finishedAt: "2099-01-01T00:00:00.000Z",
        }));
      },
    },
    fileStorage: {
      upload: (input) =>
        Promise.resolve(
          r("fileStorage.upload", [input], () => ({
            fileId: "stub-file",
            uploadUrl: "https://storage.local/upload/stub-file",
            expiresAt: "2099-01-01T00:00:00Z",
            requiredHeaders: {},
          })) as UploadResponse,
        ),
      getDownloadUrl: (fileId) =>
        Promise.resolve(
          r("fileStorage.getDownloadUrl", [fileId], () => ({
            downloadUrl: `https://storage.local/download/${fileId}`,
            expiresAt: "2099-01-01T00:00:00Z",
          })) as DownloadUrlResponse,
        ),
      list: (listOpts) =>
        Promise.resolve(
          r("fileStorage.list", [listOpts], () => ({
            files: [],
            limit: 20,
            offset: 0,
            hasMore: false,
          })) as ListResponse,
        ),
      delete: (fileId) =>
        Promise.resolve(
          r("fileStorage.delete", [fileId], () => undefined) as void,
        ),
      setVisibility: (fileId, visibility) =>
        Promise.resolve(
          r("fileStorage.setVisibility", [fileId, visibility], () => ({
            fileId,
            contentType: "application/octet-stream",
            visibility,
            status: "uploaded",
            createdAt: "2099-01-01T00:00:00Z",
            downloadRequestCount: 0,
          })) as FileMetadata,
        ),
    },
    contentGeneration: {
      images: {
        create: (input) =>
          Promise.resolve(
            r("contentGeneration.images.create", [input], () => ({
              images: [
                {
                  url: "https://content.local/stub-image.png",
                  contentType: "image/png",
                  width: 512,
                  height: 512,
                  // mirror the real behavior: a fileId only when storage was requested.
                  ...(input.storage
                    ? {
                        fileId: "stub-file",
                        downloadUrl: "https://content.local/stub-download",
                        downloadUrlExpiresAt: "2026-01-01T00:00:00Z",
                      }
                    : {}),
                },
              ],
            })) as ImageGenerationResult,
          ),
      },
      video: {
        create: (input) =>
          Promise.resolve(
            r("contentGeneration.video.create", [input], () => ({
              video: {
                url: "https://content.local/stub-video.mp4",
                contentType: "video/mp4",
                // mirror the real behavior: a fileId only when storage was requested.
                ...(input.storage
                    ? {
                        fileId: "stub-file",
                        downloadUrl: "https://content.local/stub-download",
                        downloadUrlExpiresAt: "2026-01-01T00:00:00Z",
                      }
                    : {}),
              },
            })) as VideoGenerationResult,
          ),
        launch: (input) => {
          const requestId = `stub-video-${++launchSeq}`;
          const result = r(
            dispatchedKeys("contentGeneration.video"),
            [input],
            () => ({
              video: {
                url: "https://content.local/stub-video.mp4",
                contentType: "video/mp4",
                ...(input.storage
                    ? {
                        fileId: "stub-file",
                        downloadUrl: "https://content.local/stub-download",
                        downloadUrlExpiresAt: "2026-01-01T00:00:00Z",
                      }
                    : {}),
              },
            }),
          ) as VideoGenerationResult;

          const handle: VideoLaunchHandle = {
            requestId,
            dispatch: {
              correlationId: requestId,
              resultSignal: VIDEO_RESULT_SIGNAL,
            },
            wait: () => Promise.resolve(result),
          };

          // Register the resume payload so a local `pauseUntilSignal` on this handle
          // resolves with a VideoResultPayload.
          return dispatchable(handle, opts.signals, () =>
            toVideoResumePayload(result),
          );
        },
      },
    },
    search: {
      scrape: (input) =>
        Promise.resolve(
          r("search.scrape", [input], () => ({
            url: input.url,
            markdown: `# ${input.url}\n\n(stub) scraped content`,
            metadata: {
              title: "Stub Page",
              sourceUrl: input.url,
              statusCode: 200,
            },
          })) as ScrapeResult,
        ),
      webSearch: (input) =>
        Promise.resolve(
          r("search.webSearch", [input], () => ({
            query: input.query,
            // mirror the real shape: an answer for the default intent, omitted for "links".
            ...(input.intent === "links"
              ? {}
              : { answer: `(stub) answer for "${input.query}"` }),
            results: [
              {
                title: "Stub Result",
                url: "https://example.com",
                snippet: `(stub) result for "${input.query}"`,
              },
            ],
          })) as WebSearchResponse,
        ),
      emailSearch: {
        findEmail: (input) =>
          Promise.resolve(
            r("search.emailSearch.findEmail", [input], () => {
              const domain = input.domain ?? "example.com";
              const name = input.fullName
                ? input.fullName.toLowerCase().replace(/\s+/g, ".")
                : [input.firstName, input.lastName]
                    .filter(Boolean)
                    .join(".")
                    .toLowerCase() || "contact";
              return {
                email: `${name}@${domain}`,
                score: 90,
                ...(input.firstName && { firstName: input.firstName }),
                ...(input.lastName && { lastName: input.lastName }),
                ...(input.company && { company: input.company }),
              };
            }) as FindEmailResult,
          ),
        verifyEmail: (input) =>
          Promise.resolve(
            r("search.emailSearch.verifyEmail", [input], () => ({
              email: input.email,
              status: "valid",
              result: "deliverable",
              score: 95,
              smtpCheck: true,
              acceptAll: false,
              disposable: false,
              webmail: false,
            })) as VerifyEmailResult,
          ),
        domainSearch: (input) =>
          Promise.resolve(
            r("search.emailSearch.domainSearch", [input], () => ({
              domain: input.domain,
              organization: "Stub Org",
              pattern: "{first}.{last}",
              acceptAll: false,
              emails: [
                {
                  email: `contact@${input.domain}`,
                  type: "generic",
                  confidence: 90,
                },
              ],
            })) as DomainSearchResult,
          ),
      },
    },
    database: {
      create: (input) =>
        Promise.resolve(
          r("database.create", [input], () => {
            const handle = input.handle ?? null;
            const name = `stub-${handle ?? "db"}`;
            return {
              id: "stub-db",
              handle,
              name: input.name ?? null,
              description: input.description ?? null,
              status: "active",
              region: input.region ?? "us-east-1",
              pgVersion: input.pgVersion ?? 17,
              duration: input.duration,
              connection: {
                connectionString: `postgresql://stub_user:stub_pass@localhost:5432/${name}`,
                host: "localhost",
                port: 5432,
                username: "stub_user",
                password: "stub_pass",
                databaseName: name,
              },
              expiresAt: "2099-01-01T00:00:00Z",
              createdAt: "2099-01-01T00:00:00Z",
            };
          }) as Database,
        ),
      get: (idOrHandle) =>
        Promise.resolve(
          r("database.get", [idOrHandle], () => ({
            id: "stub-db",
            handle: idOrHandle,
            name: `stub-${idOrHandle}`,
            description: null,
            status: "active",
            region: "us-east-1",
            pgVersion: 17,
            duration: "1h",
            connection: {
              connectionString: `postgresql://stub_user:stub_pass@localhost:5432/stub-${idOrHandle}`,
              host: "localhost",
              port: 5432,
              username: "stub_user",
              password: "stub_pass",
              databaseName: `stub-${idOrHandle}`,
            },
            expiresAt: "2099-01-01T00:00:00Z",
            createdAt: "2099-01-01T00:00:00Z",
          })) as Database,
        ),
      delete: (idOrHandle) =>
        Promise.resolve(
          r("database.delete", [idOrHandle], () => undefined) as void,
        ),
    },
    email: {
      inboxes: {
        create: (input) =>
          Promise.resolve(
            r("email.inboxes.create", [input], () => {
              const username = input?.username ?? "inbox";
              const domain = input?.domain ?? "example.com";
              return {
                inboxId: `${username}@${domain}`,
                email: `${username}@${domain}`,
                ...(input?.displayName && { displayName: input.displayName }),
                ...(input?.clientId && { clientId: input.clientId }),
                createdAt: "2099-01-01T00:00:00Z",
                updatedAt: "2099-01-01T00:00:00Z",
              };
            }) as Inbox,
          ),
        list: (opts) =>
          Promise.resolve(
            r("email.inboxes.list", [opts], () => ({
              count: 0,
              inboxes: [],
            })) as InboxList,
          ),
        get: (inboxId) =>
          Promise.resolve(
            r("email.inboxes.get", [inboxId], () => ({
              inboxId,
              email: inboxId,
              createdAt: "2099-01-01T00:00:00Z",
              updatedAt: "2099-01-01T00:00:00Z",
            })) as Inbox,
          ),
        delete: (inboxId) =>
          Promise.resolve(
            r("email.inboxes.delete", [inboxId], () => undefined) as void,
          ),
      },
      messages: {
        send: (inboxId, input) =>
          Promise.resolve(
            r("email.messages.send", [inboxId, input], () => ({
              messageId: `stub-msg-${++launchSeq}`,
              threadId: `stub-thread-${launchSeq}`,
            })) as SendResult,
          ),
        list: (inboxId, opts) =>
          Promise.resolve(
            r("email.messages.list", [inboxId, opts], () => ({
              count: 0,
              messages: [],
            })) as MessageList,
          ),
        get: (inboxId, messageId) =>
          Promise.resolve(
            r("email.messages.get", [inboxId, messageId], () => ({
              messageId,
              threadId: "stub-thread",
              inboxId,
              from: "sender@example.com",
              to: [inboxId],
              labels: [],
              timestamp: "2099-01-01T00:00:00Z",
              size: 0,
              createdAt: "2099-01-01T00:00:00Z",
              updatedAt: "2099-01-01T00:00:00Z",
            })) as Message,
          ),
        reply: (inboxId, messageId, input) =>
          Promise.resolve(
            r("email.messages.reply", [inboxId, messageId, input], () => ({
              messageId: `stub-msg-${++launchSeq}`,
              threadId: `stub-thread-${launchSeq}`,
            })) as SendResult,
          ),
        replyAll: (inboxId, messageId, input) =>
          Promise.resolve(
            r("email.messages.replyAll", [inboxId, messageId, input], () => ({
              messageId: `stub-msg-${++launchSeq}`,
              threadId: `stub-thread-${launchSeq}`,
            })) as SendResult,
          ),
        forward: (inboxId, messageId, input) =>
          Promise.resolve(
            r("email.messages.forward", [inboxId, messageId, input], () => ({
              messageId: `stub-msg-${++launchSeq}`,
              threadId: `stub-thread-${launchSeq}`,
            })) as SendResult,
          ),
      },
      domains: {
        create: (input) =>
          Promise.resolve(
            r("email.domains.create", [input], () => ({
              domainId: "stub-domain",
              domain: input.domain,
              status: "PENDING" as const,
              feedbackEnabled: input.feedbackEnabled ?? false,
              records: [],
              createdAt: "2099-01-01T00:00:00Z",
              updatedAt: "2099-01-01T00:00:00Z",
            })) as Domain,
          ),
        verify: (domainId) =>
          Promise.resolve(
            r("email.domains.verify", [domainId], () => undefined) as void,
          ),
        get: (domainId) =>
          Promise.resolve(
            r("email.domains.get", [domainId], () => ({
              domainId,
              domain: "example.com",
              status: "VERIFIED" as const,
              feedbackEnabled: false,
              records: [],
              createdAt: "2099-01-01T00:00:00Z",
              updatedAt: "2099-01-01T00:00:00Z",
            })) as Domain,
          ),
        list: () =>
          Promise.resolve(
            r("email.domains.list", [], () => ({
              count: 0,
              domains: [],
            })) as DomainList,
          ),
        delete: (domainId) =>
          Promise.resolve(
            r("email.domains.delete", [domainId], () => undefined) as void,
          ),
      },
      threads: {
        list: (inboxId, opts) =>
          Promise.resolve(
            r("email.threads.list", [inboxId, opts], () => ({
              count: 0,
              threads: [],
            })) as ThreadList,
          ),
        get: (inboxId, threadId) =>
          Promise.resolve(
            r("email.threads.get", [inboxId, threadId], () => ({
              threadId,
              inboxId,
              labels: [],
              timestamp: "2099-01-01T00:00:00Z",
              senders: [],
              recipients: [],
              lastMessageId: "stub-msg",
              messageCount: 0,
              size: 0,
              createdAt: "2099-01-01T00:00:00Z",
              updatedAt: "2099-01-01T00:00:00Z",
              messages: [],
            })) as Thread,
          ),
      },
      webhooks: {
        create: (input) =>
          Promise.resolve(
            r("email.webhooks.create", [input], () => ({
              id: ++launchSeq,
              url: input.url,
              eventType: input.eventType,
              secret: "stub-webhook-secret",
            })) as Webhook,
          ),
        delete: (id) =>
          Promise.resolve(
            r("email.webhooks.delete", [id], () => undefined) as void,
          ),
      },
    },
    domains: {
      check: (input) =>
        Promise.resolve(
          r("domains.check", [input], () =>
            (input.domainNames ?? []).map((domainName) => ({
              domainName,
              available: true,
              purchasePrice: "12.99",
              renewalPrice: "12.99",
              premium: false,
            })),
          ) as DomainAvailability[],
        ),
      register: (input) =>
        Promise.resolve(
          r("domains.register", [input], () => ({
            domainName: input.domainName,
            status: "active",
            expiresAt: "2099-01-01T00:00:00Z",
            registeredAt: "2099-01-01T00:00:00Z",
            purchasePrice: "12.99",
          })) as OwnedDomain,
        ),
      renew: (input) =>
        Promise.resolve(
          r("domains.renew", [input], () => ({
            domainName: input.domainName,
            expiresAt: "2099-01-01T00:00:00Z",
            renewalPrice: "12.99",
          })) as OwnedDomain,
        ),
      list: () =>
        Promise.resolve(r("domains.list", [], () => []) as OwnedDomain[]),
      get: (input) =>
        Promise.resolve(
          r("domains.get", [input], () => ({
            domainName: input.domainName,
            status: "active",
            expiresAt: "2099-01-01T00:00:00Z",
            registeredAt: "2099-01-01T00:00:00Z",
            nameservers: ["ns1.example.com", "ns2.example.com"],
            locked: true,
            transferEligibleAt: null,
          })) as OwnedDomain,
        ),
      transferOut: (input) =>
        Promise.resolve(
          r("domains.transferOut", [input], () => ({
            domainName: input.domainName,
            authCode: "stub-auth-code",
            transferInstructions:
              "(stub) provide this auth code to the new registrar.",
          })) as DomainTransfer,
        ),
      dns: {
        create: (input) =>
          Promise.resolve(
            r("domains.dns.create", [input], () => ({
              recordId: `stub-record-${++launchSeq}`,
              domainName: input.domainName,
              type: input.type,
              host: input.host,
              fqdn: input.host
                ? `${input.host}.${input.domainName}`
                : input.domainName,
              value: input.value,
              ttl: input.ttl ?? 300,
              ...(input.priority !== undefined && { priority: input.priority }),
              createdAt: "2099-01-01T00:00:00Z",
            })) as DnsRecord,
          ),
        list: (input) =>
          Promise.resolve(
            r("domains.dns.list", [input], () => []) as DnsRecord[],
          ),
        get: (input) =>
          Promise.resolve(
            r("domains.dns.get", [input], () => ({
              recordId: input.recordId,
              domainName: input.domainName,
              type: "A" as const,
              host: "",
              fqdn: input.domainName,
              value: "203.0.113.10",
              ttl: 300,
            })) as DnsRecord,
          ),
        update: (input) =>
          Promise.resolve(
            r("domains.dns.update", [input], () => ({
              recordId: input.recordId,
              domainName: input.domainName,
              type: input.type ?? ("A" as const),
              host: input.host ?? "",
              fqdn: input.domainName,
              value: input.value ?? "203.0.113.10",
              ttl: input.ttl ?? 300,
              ...(input.priority !== undefined && { priority: input.priority }),
            })) as DnsRecord,
          ),
        delete: (input) =>
          Promise.resolve(
            r("domains.dns.delete", [input], () => undefined) as void,
          ),
      },
    },
    memory: {
      append: (input) =>
        Promise.resolve(
          r("memory.append", [input], () => ({
            id: "stub-memory",
            content: input.content,
            scope: input.scope ?? "default",
            decision: "ADDED",
            createdAt: "2099-01-01T00:00:00Z",
            occurredAt: input.occurredAt ?? null,
            metadata: input.metadata ?? {},
          })) as AppendResult,
        ),
      recall: (input) =>
        Promise.resolve(
          r("memory.recall", [input], () => ({
            results: [],
            query: input.query,
            topK: input.topK ?? 5,
            count: 0,
          })) as RecallResponse,
        ),
      sweep: (input) =>
        Promise.resolve(
          r("memory.sweep", [input], () =>
            input?.dryRun === false
              ? { evicted: 0 }
              : { evicted: 0, candidates: [] },
          ) as MemorySweepResponse,
        ),
      get: (id: string, options?: MemoryCallOptions) =>
        Promise.resolve(
          r("memory.get", [id, options], () => ({
            id,
            content: "(stub) memory content",
            scope: "default",
            createdAt: "2099-01-01T00:00:00Z",
            occurredAt: null,
            lastAccessedAt: null,
            metadata: {},
          })) as Memory,
        ),
      forget: (id: string, options?: MemoryCallOptions) =>
        Promise.resolve(
          r("memory.forget", [id, options], () => undefined) as void,
        ),
    },
    withAttribution: () => client,
  };

  return client;
}
