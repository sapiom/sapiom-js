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
import {
  LLM_ROUTE_RESULT_SIGNAL,
  LLM_SESSION_READY_SIGNAL,
  readDisclosure as llmReadDisclosure,
  textOf as llmTextOf,
  structuredOf as llmStructuredOf,
} from "../llm/index.js";
import type {
  AgentRunResult,
  RunHandle as AgentRunHandle,
} from "../agents/index.js";
import type {
  LlmGrantLink,
  LlmRouteHandle,
  LlmRouteResultPayload,
  LlmSession,
  LlmSessionHandle,
  LlmStructuredOutputSpec,
} from "../llm/index.js";
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
  IMAGE_RESULT_SIGNAL,
  toVideoResumePayload,
  toImageResumePayload,
} from "../content-generation/index.js";
import type {
  ImageCreateInput,
  ImageGenerationResult,
  ImageLaunchHandle,
  VideoCreateInput,
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
import { MemoryHttpError } from "../memory/index.js";
import type {
  AppendResult,
  RecallMatch,
  RecallResponse,
  RetrievalStrategy,
  ForgetInput,
  MemoryMetadata,
  MemoryMetadataValue,
} from "../memory/index.js";
import type { SpeechResult, VoicesResult } from "../speech/index.js";
import type {
  BrowserSession,
  SessionSettlement,
  Screenshot,
  Identity,
  ActiveSession,
} from "../browser-automation/index.js";
import type { ScopedKey } from "../keys/index.js";
import type { LiveCredential, AuthClientLike } from "../google/index.js";

/**
 * Host used in the stub Postgres DSN.
 *
 * `.invalid` is reserved by RFC 6761 and does not resolve on any conforming
 * resolver, so a template that dials the stub DSN fails at name resolution
 * rather than opening a socket to whatever real Postgres happens to be
 * listening on the author's own `localhost:5432`. A resolver that hijacks
 * NXDOMAIN can still hand back an address, which is why this is a backstop and
 * not the guard: step code holding a raw Postgres connection should gate the
 * dial on `ctx.isLocalTrace` rather than rely on the DSN being unreachable.
 *
 * `database.get` itself still succeeds; only dialing what it returns fails.
 */
const STUB_DB_HOST = "sapiom-run-local-stub.invalid";

/** Per-capability overrides, keyed by capability path (see module docs). */
export type StubOverrides = Record<
  string,
  unknown | ((...args: unknown[]) => unknown)
>;

/** A single capability call record pushed into the calls sink. */
export interface StubCallRecord {
  /** Dotted capability id (provider-agnostic — never a provider/model name). */
  capability: string;
  /** Always true: every call from a stub client was served by a stub. */
  stubUsed: true;
  /** The arguments passed to the capability call. */
  args: unknown[];
  /** The value the stub returned for this call. */
  result: unknown;
}

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
  /**
   * When provided, every resolved capability call is pushed here as a
   * {@link StubCallRecord}. A local runner creates this array per-step and
   * attaches it to the step's trace so the inspector can show "what did each
   * step actually call (and receive back from the stub)".
   */
  calls?: StubCallRecord[];
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
 *
 * When `callsSink` is provided, every resolved call is pushed as a
 * {@link StubCallRecord} so the inspector can show what each step called.
 * `capability` is the primary path (first candidate, which is the dotted
 * capability id the caller wrote — e.g. `search.webSearch`, `memory.append`).
 */
function resolve(
  overrides: StubOverrides,
  paths: string | string[],
  args: unknown[],
  fallback: () => unknown,
  callsSink?: StubCallRecord[],
  capabilityOverride?: string,
): unknown {
  const pathList = typeof paths === "string" ? [paths] : paths;
  for (const path of pathList) {
    if (Object.prototype.hasOwnProperty.call(overrides, path)) {
      const o = overrides[path];
      const result =
        typeof o === "function"
          ? (o as (...a: unknown[]) => unknown)(...args)
          : o;
      callsSink?.push({
        capability: capabilityOverride ?? pathList[0],
        stubUsed: true,
        args,
        result,
      });
      return result;
    }
  }
  const result = fallback();
  callsSink?.push({
    capability: capabilityOverride ?? pathList[0],
    stubUsed: true,
    args,
    result,
  });
  return result;
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
 * The override keys a contentGeneration `launch` accepts, in precedence order: the method
 * actually called (`<ns>.launch`), then the real blocking sibling (`<ns>.create` — the key
 * authors already write for the sync verb, so a step that moves from `create()` to `launch()`
 * keeps its stub), then the legacy `<ns>.run` spelling {@link dispatchedKeys} consulted here
 * before 0.28.1 — contentGeneration has no `run` method, but the key resolved, so it stays
 * honored for back-compat.
 */
function mediaDispatchedKeys(namespace: string): string[] {
  return [`${namespace}.launch`, `${namespace}.create`, `${namespace}.run`];
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
function asRepository(
  data: unknown,
  overrides: StubOverrides,
  callsSink?: StubCallRecord[],
): Repository {
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
    callsSink,
  );
}

/** Sandbox counterpart to {@link asRepository}. */
function asSandbox(
  data: unknown,
  overrides: StubOverrides,
  callsSink?: StubCallRecord[],
): Sandbox {
  const d = (data ?? {}) as { name?: string; workspaceRoot?: string };
  return stubSandbox(
    { name: d.name ?? "stub-sandbox", workspaceRoot: d.workspaceRoot },
    overrides,
    callsSink,
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
  callsSink?: StubCallRecord[],
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
    return asRepository(el, overrides, callsSink);
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
  callsSink?: StubCallRecord[],
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
            resolve(
              overrides,
              `${type}.${key}`,
              args,
              () => defaults[key]?.(args),
              callsSink,
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
  // A method with no default here returns `undefined`, and the caller
  // dereferences it — `deployPreview(...).status` threw
  // "Cannot read properties of undefined" under `run_local` rather than
  // reporting a missing stub. These are the handle methods templates in
  // `examples/` actually call, so a zero-stub local run traces the graph
  // instead of dying on the shape of a stub that was never there.
  deployPreview: () => ({
    url: "https://stub-preview.local",
    status: "deployed",
    logs: "",
  }),
  createPublicUrl: () => ({ url: "https://stub-preview.local", name: "stub" }),
  uploadFile: () => undefined,
  uploadDir: () => undefined,
};

function stubRepository(
  data: { slug: string; cloneUrl: string; status?: string },
  overrides: StubOverrides,
  callsSink?: StubCallRecord[],
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
    callsSink,
  ) as Repository;
}

function stubSandbox(
  data: { name: string; workspaceRoot?: string },
  overrides: StubOverrides,
  callsSink?: StubCallRecord[],
): Sandbox {
  return makeHandle(
    "sandbox",
    SANDBOX_METHODS,
    { name: data.name, workspaceRoot: data.workspaceRoot ?? "/workspace" },
    overrides,
    SANDBOX_METHOD_DEFAULTS,
    callsSink,
  ) as Sandbox;
}

function stubCodingResult(
  overrides: StubOverrides,
  callsSink?: StubCallRecord[],
): CodingRunResult {
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
    sandbox: stubSandbox({ name: "stub-sandbox" }, overrides, callsSink),
  };
}

function stubRunHandle(
  overrides: StubOverrides,
  correlationId: string,
  result: CodingRunResult,
  callsSink?: StubCallRecord[],
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
    callsSink,
  ) as RunHandle;
}

// Default media results for the contentGeneration stub — ONE factory per media type, shared by
// `create` and `launch` so the two verbs can never drift (the create/launch resolvedModel drift
// fixed in #664 came from inlined twin literals). SAP-2576: the routed backend always echoes a
// resolvedModel (a required field), so the factory does too — set here, inside the fallback,
// never post-mutated onto a resolved override.
function stubImageResult(input: ImageCreateInput): ImageGenerationResult {
  return {
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
    resolvedModel: input.model ?? "stub-model",
  };
}

/** As {@link stubImageResult}, for video. */
function stubVideoResult(input: VideoCreateInput): VideoGenerationResult {
  return {
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
    resolvedModel: input.model ?? "stub-model",
  };
}

/**
 * Build a placeholder value satisfying a `LlmRunSpec.output` JSON Schema, so the
 * stubbed forced tool call answers in the shape the caller declared.
 *
 * Deliberately minimal — required properties only, one element per array, the
 * first `enum` member, `minimum`/`minItems` respected — and every string is
 * visibly a stub. The point is to let `run_local` trace a graph whose steps read
 * structured output; a step that branches on the actual VALUE should still
 * override `llm.run` in its stub file.
 */
function stubStructuredOutput(
  schema: Record<string, unknown>,
  label = "value",
): unknown {
  const type = Array.isArray(schema.type)
    ? schema.type.find((t) => t !== "null")
    : schema.type;
  const asEnum = Array.isArray(schema.enum) ? schema.enum : null;
  if (asEnum && asEnum.length > 0) return asEnum[0];

  switch (type) {
    case "object": {
      const properties = (schema.properties ?? {}) as Record<string, unknown>;
      const required = Array.isArray(schema.required)
        ? schema.required.filter((k): k is string => typeof k === "string")
        : Object.keys(properties);
      const out: Record<string, unknown> = {};
      for (const key of required) {
        const child = properties[key];
        out[key] =
          child && typeof child === "object"
            ? stubStructuredOutput(child as Record<string, unknown>, key)
            : `(stub) ${key}`;
      }
      return out;
    }
    case "array": {
      const items = schema.items;
      const minItems =
        typeof schema.minItems === "number" ? schema.minItems : 1;
      const count = Math.max(1, minItems);
      if (!items || typeof items !== "object") return [];
      return Array.from({ length: count }, () =>
        stubStructuredOutput(items as Record<string, unknown>, label),
      );
    }
    case "number":
    case "integer":
      return typeof schema.minimum === "number" ? schema.minimum : 0;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return `(stub) ${label}`;
  }
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
  callsSink?: StubCallRecord[],
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
    callsSink,
  ) as ModelRunHandle;
}

/**
 * Create a stub `Sapiom` client. Runs every capability against built-in defaults;
 * pass `overrides` to control the results a step branches on.
 */
/** One memory row in the stub's in-process store. */
interface StubMemoryRecord {
  id: string;
  content: string;
  createdAt: string;
  occurredAt?: string;
  /** The stored metadata; undefined when empty. */
  metadata?: MemoryMetadata;
  /** Leaf view — what recall `filter` keys match against. */
  flat: Map<string, MemoryMetadataValue>;
}

/**
 * Validate flat memory metadata with the same observable rules a caller sees on
 * the real service: keys are identifiers (`^[a-zA-Z]\w*$` — a leading letter,
 * then letters, digits, or underscores), values are string/number/boolean
 * (objects, arrays, and nulls are `invalid_metadata`), and `undefined` values
 * are absent. Whole-store bounds (key counts, byte caps) are not simulated here.
 */
function validateStubMemoryMetadata(
  metadata: MemoryMetadata,
): Map<string, MemoryMetadataValue> {
  const out = new Map<string, MemoryMetadataValue>();
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    if (key.includes(".")) {
      throw new MemoryHttpError(
        `invalid_metadata: key '${key}' must not contain '.' — keys must start with a letter and contain only letters, digits, or underscores`,
        400,
        { code: "invalid_metadata" },
      );
    }
    if (!/^[a-zA-Z]\w*$/.test(key)) {
      throw new MemoryHttpError(
        `invalid_metadata: key '${key}' is invalid — keys must start with a letter and contain only letters, digits, or underscores`,
        400,
        { code: "invalid_metadata" },
      );
    }
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new MemoryHttpError(
        `invalid_metadata: value at '${key}' must be a string, number, or boolean`,
        400,
        { code: "invalid_metadata" },
      );
    }
    out.set(key, value);
  }
  return out;
}

/** {@link RetrievalStrategy} is type-level only — this is its runtime enumeration for the stub's recall check. */
const STUB_RETRIEVAL_STRATEGIES: readonly RetrievalStrategy[] = [
  "semantic",
  "keyword",
  "hybrid",
];

/** A recall filter value matches a record's flattened leaf: `{in}` set or strict scalar equality. */
function stubMemoryFilterMatches(
  record: StubMemoryRecord,
  filter: Record<string, unknown> | undefined,
): boolean {
  if (!filter) return true;
  for (const [key, expected] of Object.entries(filter)) {
    const actual = record.flat.get(key);
    if (
      expected !== null &&
      typeof expected === "object" &&
      Array.isArray((expected as { in?: unknown[] }).in)
    ) {
      if (!(expected as { in: unknown[] }).in.includes(actual as unknown))
        return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

export function createStubClient(opts: StubClientOptions = {}): Sapiom {
  // Record which override keys actually match a call, so the runner can flag
  // supplied-but-unmatched keys (typos / wrong plural-singular form).
  const overrides = recordingOverrides(opts.overrides ?? {}, opts.usedKeys);
  const r = (
    paths: string | string[],
    args: unknown[],
    fallback: () => unknown,
    capabilityOverride?: string,
  ) =>
    resolve(overrides, paths, args, fallback, opts.calls, capabilityOverride);

  // Per-client memory state: namespace → (id → record). See the `memory`
  // capability below for what is and isn't simulated.
  const memoryNamespaces = new Map<string, Map<string, StubMemoryRecord>>();
  let memorySeq = 0;

  // Resolve a coding run result, then re-wrap its `sandbox` as a handle so the
  // blocking `run()` path keeps a method-capable Sandbox even when the result was
  // overridden with plain JSON. `keys` lets `launch()` accept `models.coding.launch`
  // (the call the author wrote) as well as the shared `models.coding.run`.
  const resolveCodingResult = (
    spec: unknown,
    keys: string | string[],
  ): CodingRunResult => {
    const res = r(keys, [spec], () =>
      stubCodingResult(overrides, opts.calls),
    ) as CodingRunResult;
    return { ...res, sandbox: asSandbox(res.sandbox, overrides, opts.calls) };
  };

  // Default (instant) agent result for the blocking `run()` — no sandbox to re-wrap, so it's
  // the resolved value as-is, verbatim (launch() resolves its own key list and merges over the
  // defaults instead: its handle and resume payload need the full ModelRunResult shape).
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
            opts.calls,
          ),
        ),
      attach: (name, attachOpts) =>
        asSandbox(
          r("sandboxes.attach", [name, attachOpts], () => ({ name })),
          overrides,
          opts.calls,
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
            opts.calls,
          ),
        ),
      get: (slug) =>
        Promise.resolve(
          asRepository(
            r("repositories.get", [slug], () => ({ slug })),
            overrides,
            opts.calls,
          ),
        ),
      list: () =>
        Promise.resolve(
          asRepositoryList(
            r("repositories.list", [], () => []),
            overrides,
            opts.warnings,
            opts.calls,
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
          opts.calls,
        ),
    },
    models: {
      run: (spec) => Promise.resolve(resolveModelResult(spec, "models.run")),
      launch: async (spec) => {
        const correlationId = `stub-run-${++launchSeq}`;
        // `launch()` honors `models.launch` first, then the shared `models.run` — the keys the
        // module docs promise and the ones `run()` above resolves. The `agent.*` spellings were
        // stranded by the agent→models half of the #167 rename and were the only keys this
        // path actually consulted until now, so they stay honored last for back-compat — with
        // a warning, because they sit one character away from the unrelated `agents.*`
        // namespace and would otherwise defeat the usedKeys typo detector.
        const keys = [...dispatchedKeys("models"), ...dispatchedKeys("agent")];
        const matched = keys.find((k) =>
          Object.prototype.hasOwnProperty.call(overrides, k),
        );
        if (matched?.startsWith("agent.")) {
          opts.warnings?.add(
            `'${matched}' is a legacy spelling for models.launch overrides — rename it to 'models.run' ` +
              `(or 'models.launch'). It is one character away from the 'agents.*' namespace, which it does NOT stub.`,
          );
        }
        // Unlike `run()` (verbatim, longstanding), launch() must produce a full ModelRunResult:
        // the handle reads `result.status` and the resume payload is schema-validated by the
        // local runner. Merge the override OVER the defaults — the override wins field by
        // field, missing required fields are filled, nothing is mutated. The await unwraps a
        // function override that returned a Promise (run()'s Promise.resolve does the same).
        const resolved = await Promise.resolve(
          r(keys, [spec], () => stubAgentResult()),
        );
        if (resolved === null || typeof resolved !== "object") {
          opts.warnings?.add(
            `'${matched}' stub must be a ModelRunResult-shaped object; got ${describeShape(resolved)}. ` +
              `Using the built-in default.`,
          );
        }
        const base = (
          resolved !== null && typeof resolved === "object" ? resolved : {}
        ) as Partial<ModelRunResult>;
        const result: ModelRunResult = {
          ...stubAgentResult(),
          ...base,
          // Preserve an author-supplied runId (run() would return it verbatim, and in the real
          // client run() IS launch().wait(), so the two paths must agree on the id).
          runId: base.runId ?? correlationId,
        };
        // The resume payload IS the result (no live handles to strip).
        return dispatchable(
          stubModelRunHandle(overrides, result.runId, result, opts.calls),
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
            stubRunHandle(overrides, correlationId, result, opts.calls),
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
    llm: {
      run: <T = Record<string, unknown>>(spec: {
        request: Record<string, unknown>;
        model?: string;
        complexity?: number;
        output?: LlmStructuredOutputSpec;
      }) =>
        Promise.resolve(
          r("llm.run", [spec], () => ({
            id: "stub-msg",
            type: "message",
            role: "assistant",
            model: spec.model ?? "smart",
            // `output` forces a tool call on the real surface, so the stub has
            // to answer in the same shape — otherwise `structuredOf` reads
            // `undefined` locally for code that would get a value in
            // production, and every caller that (rightly) refuses to invent a
            // value fails under `run_local` for the wrong reason.
            content: spec.output
              ? [
                  {
                    type: "tool_use",
                    id: "stub-tool-use",
                    name: spec.output.name,
                    input: stubStructuredOutput(spec.output.schema),
                  },
                ]
              : [{ type: "text", text: "(stub) llm reply" }],
            stop_reason: spec.output ? "tool_use" : "end_turn",
          })) as T,
        ),
      submit: (spec) => {
        const executionId = `stub-exec-${++launchSeq}`;
        const stubLink: LlmGrantLink = {
          anthropicBaseUrl: "https://llm.local",
          apiKey: "sapiom-grant-stub",
          model: spec.model ?? "smart",
          expiresAtMs: 4102444800000,
          usage: "single_request",
        };
        const payload = r("llm.submit", [spec], () => ({
          executionId,
          status: "granted" as const,
          link: stubLink,
          error: null,
        })) as LlmRouteResultPayload;
        const handle: LlmRouteHandle = {
          executionId,
          dispatch: {
            correlationId: executionId,
            resultSignal: LLM_ROUTE_RESULT_SIGNAL,
          },
          status: () =>
            Promise.resolve(
              payload.status === "granted"
                ? ("granted" as const)
                : ("failed" as const),
            ),
          wait: () => Promise.resolve(payload),
        };
        // Register the resume payload so a local `pauseUntilSignal` on this handle
        // resolves with an LlmRouteResultPayload.
        return dispatchable(handle, opts.signals);
      },
      redeem: <T = Record<string, unknown>>(
        link: LlmGrantLink,
        request: Record<string, unknown>,
      ) =>
        Promise.resolve(
          r("llm.redeem", [link, request], () => ({
            id: "stub-msg",
            type: "message",
            role: "assistant",
            model: link.model,
            content: [{ type: "text", text: "(stub) llm reply" }],
            stop_reason: "end_turn",
          })) as T,
        ),
      createSession: (spec = {}) => {
        const sessionId = `stub-sess-${++launchSeq}`;
        const session = (): LlmSession =>
          r("llm.createSession", [spec], () => ({
            sessionId,
            state: "ready" as const,
            model: spec.label ?? spec.model ?? "smart",
            baseUrls: {
              anthropic: `https://llm.local/v2/sessions/${sessionId}/anthropic`,
              openai: `https://llm.local/v2/sessions/${sessionId}/openai/v1`,
            },
            expiresAtMs: 4102444800000,
            budget: {
              maxTokens: spec.budget?.maxTokens ?? null,
              usedTokens: 0,
              ttlMinutes: spec.budget?.ttlMinutes ?? null,
            },
          })) as LlmSession;
        const handle: LlmSessionHandle = {
          sessionId,
          dispatch: {
            correlationId: sessionId,
            resultSignal: LLM_SESSION_READY_SIGNAL,
          },
          get: () => Promise.resolve(session()),
          wait: () => Promise.resolve(session()),
        };
        // Register the resume payload so a local `pauseUntilSignal` on this
        // handle resolves with the ready session.
        return dispatchable(handle, opts.signals, session);
      },
      getSession: (sessionId) =>
        Promise.resolve(
          r("llm.getSession", [sessionId], () => ({
            sessionId,
            state: "ready" as const,
            model: "smart",
          })) as LlmSession,
        ),
      callSession: <T = Record<string, unknown>>(
        session: LlmSessionHandle | LlmSession | string,
        request: Record<string, unknown>,
        callOpts: { shape?: "anthropic" | "openai" } = {},
      ) =>
        Promise.resolve(
          r("llm.callSession", [session, request, callOpts], () => ({
            id: "stub-msg",
            type: "message",
            role: "assistant",
            model: "smart",
            content: [{ type: "text", text: "(stub) llm reply" }],
            stop_reason: "end_turn",
          })) as T,
        ),
      releaseSession: (session) =>
        Promise.resolve(
          r("llm.releaseSession", [session], () => ({
            sessionId:
              typeof session === "string" ? session : session.sessionId,
            state: "expired" as const,
          })) as LlmSession,
        ),
      // Pure functions over a result value, not network calls — no stub
      // recording needed; delegate straight to the real implementation.
      readDisclosure: (result) => llmReadDisclosure(result),
      textOf: (response) => llmTextOf(response),
      structuredOf: (response, name) => llmStructuredOf(response, name),
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
      // Pure/synchronous in the real client — mirror that here (no Promise wrap).
      getPublicUrl: (fileId) =>
        r(
          "fileStorage.getPublicUrl",
          [fileId],
          () => `https://storage.local/public/${fileId}`,
        ) as string,
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
            // Fallback shared with `launch` via stubImageResult (a caller-supplied override
            // wins verbatim; a frozen override is never mutated).
            r("contentGeneration.images.create", [input], () =>
              stubImageResult(input),
            ) as ImageGenerationResult,
          ),
        launch: (input) => {
          const requestId = `stub-image-${++launchSeq}`;
          const resolved = r(
            mediaDispatchedKeys("contentGeneration.images"),
            [input],
            () => stubImageResult(input),
          ) as ImageGenerationResult;
          // Mirror the real client's `withDispatchMetadata`: stamp the resolvedModel onto a COPY, so
          // the handle, `wait()`, and the resume payload all carry the same value — an invariant
          // the routed path guarantees — while the caller's override object is never touched and
          // its own resolvedModel wins when present.
          const result: ImageGenerationResult = {
            ...resolved,
            resolvedModel:
              resolved.resolvedModel ?? input.model ?? "stub-model",
          };

          const handle: ImageLaunchHandle = {
            requestId,
            resolvedModel: result.resolvedModel,
            dispatch: {
              correlationId: requestId,
              resultSignal: IMAGE_RESULT_SIGNAL,
            },
            wait: () => Promise.resolve(result),
          };

          // Register the resume payload so a local `pauseUntilSignal` on this handle
          // resolves with an ImageResultPayload.
          return dispatchable(handle, opts.signals, () =>
            toImageResumePayload(result),
          );
        },
      },
      video: {
        create: (input) =>
          Promise.resolve(
            // Fallback shared with `launch` via stubVideoResult (a caller-supplied override
            // wins verbatim; a frozen override is never mutated).
            r("contentGeneration.video.create", [input], () =>
              stubVideoResult(input),
            ) as VideoGenerationResult,
          ),
        launch: (input) => {
          const requestId = `stub-video-${++launchSeq}`;
          const resolved = r(
            mediaDispatchedKeys("contentGeneration.video"),
            [input],
            () => stubVideoResult(input),
          ) as VideoGenerationResult;
          // Mirror the real client's `withDispatchMetadata`: stamp the resolvedModel onto a COPY, so
          // the handle, `wait()`, and the resume payload all carry the same value — an invariant
          // the routed path guarantees — while the caller's override object is never touched and
          // its own resolvedModel wins when present.
          const result: VideoGenerationResult = {
            ...resolved,
            resolvedModel:
              resolved.resolvedModel ?? input.model ?? "stub-model",
          };

          const handle: VideoLaunchHandle = {
            requestId,
            resolvedModel: result.resolvedModel,
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
                connectionString: `postgresql://stub_user:stub_pass@${STUB_DB_HOST}:5432/${name}`,
                host: STUB_DB_HOST,
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
              connectionString: `postgresql://stub_user:stub_pass@${STUB_DB_HOST}:5432/stub-${idOrHandle}`,
              host: STUB_DB_HOST,
              port: 5432,
              username: "stub_user",
              password: "stub_pass",
              databaseName: `stub-${idOrHandle}`,
            },
            expiresAt: "2099-01-01T00:00:00Z",
            createdAt: "2099-01-01T00:00:00Z",
          })) as Database,
        ),
      list: () =>
        Promise.resolve(r("database.list", [], () => []) as Database[]),
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
    // Stateful, semantically faithful memory stub: appends land in an in-process
    // per-namespace store; recall applies the SDK's filter semantics (flat keys,
    // `{in}` sets); forget is blind-idempotent; drop clears the namespace. NOT
    // simulated: relevance ranking (offline — every filter-matching record
    // returns with score 1, insertion order) and whole-store bounds (key
    // counts / byte caps).
    memory: {
      // Deferred so a validation throw inside the fallback REJECTS the returned
      // promise (the async contract) instead of throwing synchronously.
      append: (input) =>
        Promise.resolve().then(
          () =>
            r("memory.append", [input], () => {
              const flat = input.metadata
                ? validateStubMemoryMetadata(input.metadata)
                : new Map<string, MemoryMetadataValue>();
              const metadata =
                input.metadata !== undefined &&
                Object.keys(input.metadata).length > 0
                  ? input.metadata
                  : undefined;
              const record: StubMemoryRecord = {
                id: `stub-memory-${++memorySeq}`,
                content: input.content,
                createdAt: "2099-01-01T00:00:00Z",
                ...(input.occurredAt !== undefined && {
                  occurredAt: input.occurredAt,
                }),
                ...(metadata !== undefined && { metadata }),
                flat,
              };
              const namespace = input.namespace ?? "default";
              const records =
                memoryNamespaces.get(namespace) ??
                new Map<string, StubMemoryRecord>();
              records.set(record.id, record);
              memoryNamespaces.set(namespace, records);
              const result: AppendResult = {
                id: record.id,
                content: record.content,
                createdAt: record.createdAt,
                ...(record.metadata !== undefined && {
                  metadata: record.metadata,
                }),
                ...(record.occurredAt !== undefined && {
                  occurredAt: record.occurredAt,
                }),
              };
              return result;
            }) as AppendResult,
        ),
      // Deferred so a validation throw inside the fallback REJECTS the returned
      // promise (the async contract) instead of throwing synchronously.
      recall: (input) =>
        Promise.resolve().then(
          () =>
            r("memory.recall", [input], () => {
              if (
                input.strategy !== undefined &&
                !STUB_RETRIEVAL_STRATEGIES.includes(input.strategy)
              ) {
                const message = `strategy must be one of the following values: ${STUB_RETRIEVAL_STRATEGIES.join(", ")}`;
                throw new MemoryHttpError(message, 400, { message });
              }
              const records = memoryNamespaces.get(
                input.namespace ?? "default",
              );
              const topK = input.topK ?? 5;
              const results: RecallMatch[] = [...(records?.values() ?? [])]
                .filter((record) =>
                  stubMemoryFilterMatches(record, input.filter),
                )
                .slice(0, topK)
                .map((record) => ({
                  id: record.id,
                  content: record.content,
                  score: 1,
                  createdAt: record.createdAt,
                  occurredAt: record.occurredAt ?? null,
                  metadata: record.metadata ?? null,
                }));
              return {
                results,
                query: input.query,
                topK,
                count: results.length,
              } satisfies RecallResponse;
            }) as RecallResponse,
        ),
      forget: (input: ForgetInput) =>
        Promise.resolve(
          r("memory.forget", [input], () => {
            const records = memoryNamespaces.get(input.namespace ?? "default");
            for (const id of input.ids) records?.delete(id);
            return undefined;
          }) as void,
        ),
      drop: (namespace: string) =>
        Promise.resolve(
          r("memory.drop", [namespace], () => {
            memoryNamespaces.delete(namespace);
            return undefined;
          }) as void,
        ),
    },
    // Read-only vault (SAP-1471). Stubs return empty/absent — a local run must
    // never surface real credentials, and "no secret found" is the safe default.
    vault: {
      list: (ref: string) =>
        Promise.resolve(r("vault.list", [ref], () => []) as string[]),
      get: (ref: string, key: string) =>
        Promise.resolve(
          r("vault.get", [ref, key], () => null) as string | null,
        ),
      getMany: (ref: string, keys: string[]) =>
        Promise.resolve(
          r("vault.getMany", [ref, keys], () => ({})) as Record<string, string>,
        ),
      getAll: (ref: string) =>
        Promise.resolve(
          r("vault.getAll", [ref], () => ({})) as Record<string, string>,
        ),
    },
    // Scoped-key mint (SAP-2300). A local run mints no real credential — it returns a
    // clearly-fake, shape-faithful key so a deploy step can trace the full graph
    // offline. The `key` is an obvious placeholder, never a usable secret.
    keys: {
      mintScoped: (input) =>
        Promise.resolve(
          r("keys.mintScoped", [input], () => ({
            key: "sk_live_stub-scoped-key",
            id: "stub-scoped-key",
            expiresAt: null,
            permissions: Array.isArray(input.scope)
              ? input.scope
              : input.scope
                ? [input.scope]
                : ["org.transactions.write"],
          })) as ScopedKey,
        ),
    },
    // A live Google credential is fetched server-side in production; the stub returns
    // a clearly-fake, shape-faithful bearer so an offline run can exercise the call
    // graph. The `value` is an obvious placeholder, never a usable token.
    google: {
      token: () =>
        Promise.resolve(
          r("google.token", [], () => ({
            kind: "bearer" as const,
            value: "ya29.stub-google-token",
            expiresAt: "2099-01-01T00:00:00.000Z",
            baseUrl: "https://www.googleapis.com",
          })) as LiveCredential,
        ),
      // Shape-faithful auth client: `getRequestHeaders()` returns the same fake
      // bearer, so an offline run drives a googleapis-style client without a network
      // call. The `Authorization` value is an obvious placeholder, never usable.
      authClient: () =>
        r("google.authClient", [], () => ({
          getRequestHeaders: () =>
            Promise.resolve({
              Authorization: "Bearer ya29.stub-google-token",
            }),
        })) as AuthClientLike,
    },
    speech: {
      textToSpeech: {
        create: (input) =>
          Promise.resolve(
            r("speech.textToSpeech.create", [input], () => ({
              url: "https://cdn.example.com/stub-audio.mp3",
              expiresAt: "2099-01-01T00:00:00Z",
            })) as SpeechResult,
          ),
      },
      soundEffects: {
        create: (input) =>
          Promise.resolve(
            r("speech.soundEffects.create", [input], () => ({
              url: "https://cdn.example.com/stub-sfx.mp3",
              expiresAt: "2099-01-01T00:00:00Z",
            })) as SpeechResult,
          ),
      },
      voices: {
        list: () =>
          Promise.resolve(
            r("speech.voices.list", [], () => ({
              voices: [{ voiceId: "stub-voice", name: "Stub Voice" }],
            })) as VoicesResult,
          ),
      },
    },
    browserAutomation: {
      sessions: {
        create: () =>
          Promise.resolve(
            r("browserAutomation.sessions.create", [], () => ({
              sessionId: "stub-session",
              cdpUrl: "ws://stub.local/session/stub-session",
              expiresAt: "2099-01-01T00:00:00Z",
              maxDurationSec: 1200,
            })) as BrowserSession,
          ),
        createWithIdentity: (input) =>
          Promise.resolve(
            r("browserAutomation.sessions.createWithIdentity", [input], () => ({
              sessionId: "stub-session",
              cdpUrl: "ws://stub.local/session/stub-session",
              expiresAt: "2099-01-01T00:00:00Z",
              maxDurationSec: 1200,
            })) as BrowserSession,
          ),
        close: (sessionId) =>
          Promise.resolve(
            r("browserAutomation.sessions.close", [sessionId], () => ({
              sessionId,
              settled: true,
              capturedAmountUsd: "0.00",
              creditsUsed: 0,
            })) as SessionSettlement,
          ),
      },
      screenshot: (input) =>
        Promise.resolve(
          r("browserAutomation.screenshot", [input], () => ({
            url: "https://cdn.example.com/stub-screenshot.png",
            expiresAt: "2099-01-01T00:00:00Z",
          })) as Screenshot,
        ),
      withSession: async <T>(
        fn: (session: ActiveSession) => Promise<T>,
        sessionOpts?: { identityId?: string },
      ) => {
        const stubSession = r(
          "browserAutomation.withSession",
          // Only the serializable opts are recorded; `fn` (a closure) has no
          // useful JSON form and would show as null in the calls-sink trace.
          [sessionOpts],
          () => ({
            sessionId: "stub-session",
            cdpUrl: "ws://stub.local/session/stub-session",
            expiresAt: "2099-01-01T00:00:00Z",
            maxDurationSec: 1200,
          }),
        ) as BrowserSession;
        const activeSession: ActiveSession = {
          ...stubSession,
          screenshot: (screenshotInput?) =>
            Promise.resolve(
              r(
                "browserAutomation.screenshot",
                [{ ...screenshotInput, sessionId: stubSession.sessionId }],
                () => ({
                  url: "https://cdn.example.com/stub-screenshot.png",
                  expiresAt: "2099-01-01T00:00:00Z",
                }),
              ) as Screenshot,
            ),
        };
        try {
          return await fn(activeSession);
        } finally {
          // Stub close — swallow (mirrors the real withSession finally).
          r(
            "browserAutomation.sessions.close",
            [stubSession.sessionId],
            () => ({
              sessionId: stubSession.sessionId,
              settled: true,
              capturedAmountUsd: "0.00",
              creditsUsed: 0,
            }),
          );
        }
      },
      identities: {
        create: (input) =>
          Promise.resolve(
            r("browserAutomation.identities.create", [input], () => ({
              id: "stub-identity",
              status: "active",
            })) as Identity,
          ),
      },
    },
    withAttribution: () => client,
    // The stub makes no HTTP calls and creates no analytics emitter — nothing
    // to release, so shutdown matches the real client's "resolve immediately".
    shutdown: () => Promise.resolve(),
  };

  return client;
}
