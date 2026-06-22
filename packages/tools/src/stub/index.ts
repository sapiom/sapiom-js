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
 * path (`repositories.list`, `agent.coding.run`), handle methods by
 * `<handle>.<method>` (`repository.pushFromSandbox`, `sandbox.exec`). A value
 * replaces that capability's default; a function `(…args) => value` computes it
 * from the call arguments.
 */
import { CODING_RESULT_SIGNAL } from '../agent/index.js';
import type { CodingRunResult, RunHandle, RunStatus } from '../agent/index.js';
import type { Sapiom } from '../client.js';
import { Repository } from '../repositories/index.js';
import { Sandbox } from '../sandboxes/index.js';
import type { UploadResponse, DownloadUrlResponse, ListResponse, FileMetadata } from '../file-storage/index.js';

/** Per-capability overrides, keyed by capability path (see module docs). */
export type StubOverrides = Record<string, unknown | ((...args: unknown[]) => unknown)>;

export interface StubClientOptions {
  overrides?: StubOverrides;
  /**
   * When provided, any dispatch-able capability records `(correlationId →
   * result)` here (via {@link dispatchable}). A local runner uses it to
   * auto-resume a `pauseUntilSignal(handle, …)` with the result the handle's
   * signal would have carried.
   */
  signals?: Map<string, unknown>;
}

// Module-scoped so correlation ids are unique across launches within a run.
let launchSeq = 0;

/** A launched, pausable capability handle (the `DispatchHandle` shape). */
function isDispatchHandle(v: unknown): v is { dispatch: { correlationId: string }; wait: () => Promise<unknown> } {
  if (!v || typeof v !== 'object') return false;
  const h = v as { dispatch?: { correlationId?: unknown }; wait?: unknown };
  return typeof h.wait === 'function' && typeof h.dispatch?.correlationId === 'string';
}

/**
 * Register a dispatch-able handle's eventual result so a pause on its signal can
 * be auto-resumed, then return the handle. Capability-agnostic: any launch-style
 * stub method wraps its returned handle in this — the result a `pauseUntilSignal`
 * resumes with is exactly what the handle's `wait()` resolves to.
 */
async function dispatchable<T>(handle: T, signals?: Map<string, unknown>): Promise<T> {
  if (signals && isDispatchHandle(handle)) {
    signals.set(handle.dispatch.correlationId, await handle.wait());
  }
  return handle;
}

// Method names of each handle, reflected from the real classes so the stub stays
// in lockstep with the SDK (a renamed/added method is picked up automatically).
const REPOSITORY_METHODS = handleMethods(Repository.prototype);
const SANDBOX_METHODS = handleMethods(Sandbox.prototype);
const RUN_HANDLE_METHODS = new Set(['status', 'wait']); // RunHandle is a literal, not a class

function handleMethods(proto: object): Set<string> {
  return new Set(Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor'));
}

function resolve(overrides: StubOverrides, path: string, args: unknown[], fallback: () => unknown): unknown {
  if (Object.prototype.hasOwnProperty.call(overrides, path)) {
    const o = overrides[path];
    return typeof o === 'function' ? (o as (...a: unknown[]) => unknown)(...args) : o;
  }
  return fallback();
}

/**
 * Build a handle proxy: data fields read from `data`; declared methods resolve an
 * override (`<type>.<method>`) or a default; any other property is rejected as
 * not part of the handle.
 */
function makeHandle(
  type: 'repository' | 'sandbox' | 'runHandle',
  methods: Set<string>,
  data: Record<string, unknown>,
  overrides: StubOverrides,
  defaults: Record<string, (args: unknown[]) => unknown>,
): unknown {
  return new Proxy(data, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      const key = String(prop);
      if (key in target) return target[key]; // data field (incl. nested handles)
      if (methods.has(key)) {
        return (...args: unknown[]): Promise<unknown> =>
          Promise.resolve(resolve(overrides, `${type}.${key}`, args, () => defaults[key]?.(args)));
      }
      throw new Error(`'${type}.${key}' is not a method or field on this handle.`);
    },
  });
}

const REPO_METHOD_DEFAULTS: Record<string, (args: unknown[]) => unknown> = {
  delete: () => undefined,
  pushFromSandbox: () => ({ pushed: true, sha: 'stub00000000', branch: 'main' }),
};

const SANDBOX_METHOD_DEFAULTS: Record<string, (args: unknown[]) => unknown> = {
  exec: () => ({ pid: 'stub-proc', exitCode: 0, stdout: '', stderr: '' }),
  readFile: () => '',
  writeFile: () => undefined,
  destroy: () => undefined,
};

function stubRepository(data: { slug: string; cloneUrl: string; status?: string }, overrides: StubOverrides): Repository {
  return makeHandle(
    'repository',
    REPOSITORY_METHODS,
    { slug: data.slug, cloneUrl: data.cloneUrl, status: data.status ?? 'active' },
    overrides,
    REPO_METHOD_DEFAULTS,
  ) as Repository;
}

function stubSandbox(data: { name: string; workspaceRoot?: string }, overrides: StubOverrides): Sandbox {
  return makeHandle(
    'sandbox',
    SANDBOX_METHODS,
    { name: data.name, workspaceRoot: data.workspaceRoot ?? '/workspace' },
    overrides,
    SANDBOX_METHOD_DEFAULTS,
  ) as Sandbox;
}

function stubCodingResult(overrides: StubOverrides): CodingRunResult {
  return {
    runId: 'stub-run',
    status: 'completed' as RunStatus,
    summary: '(stub) coding run completed locally',
    result: {
      success: true,
      turns: 1,
      modelUsed: 'stub-model',
      durationMs: 0,
      toolCallCount: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 0 },
    },
    error: null,
    sandbox: stubSandbox({ name: 'stub-sandbox' }, overrides),
  };
}

function stubRunHandle(overrides: StubOverrides, correlationId: string, result: CodingRunResult): RunHandle {
  const handle = {
    runId: correlationId,
    sandbox: result.sandbox,
    dispatch: { correlationId, resultSignal: CODING_RESULT_SIGNAL },
    status: () => Promise.resolve(result.status),
    wait: () => Promise.resolve(result),
  };
  return makeHandle('runHandle', RUN_HANDLE_METHODS, handle as unknown as Record<string, unknown>, overrides, {}) as RunHandle;
}

/**
 * Create a stub `Sapiom` client. Runs every capability against built-in defaults;
 * pass `overrides` to control the results a step branches on.
 */
export function createStubClient(opts: StubClientOptions = {}): Sapiom {
  const overrides = opts.overrides ?? {};
  const r = (path: string, args: unknown[], fallback: () => unknown) => resolve(overrides, path, args, fallback);

  const client: Sapiom = {
    sandboxes: {
      create: (sandboxOpts) =>
        Promise.resolve(
          r('sandboxes.create', [sandboxOpts], () =>
            stubSandbox({ name: sandboxOpts?.name ?? 'stub-sandbox' }, overrides),
          ) as Sandbox,
        ),
      attach: (name, attachOpts) =>
        r('sandboxes.attach', [name, attachOpts], () => stubSandbox({ name }, overrides)) as Sandbox,
    },
    repositories: {
      create: (slug) =>
        Promise.resolve(
          r('repositories.create', [slug], () =>
            stubRepository({ slug, cloneUrl: `https://git.local/${slug}.git` }, overrides),
          ) as Repository,
        ),
      get: (slug) =>
        Promise.resolve(
          r('repositories.get', [slug], () =>
            stubRepository({ slug, cloneUrl: `https://git.local/${slug}.git` }, overrides),
          ) as Repository,
        ),
      list: () => Promise.resolve(r('repositories.list', [], () => []) as Repository[]),
      delete: (slug) => Promise.resolve(r('repositories.delete', [slug], () => undefined) as void),
      attach: (slug, cloneUrl) =>
        r('repositories.attach', [slug, cloneUrl], () => stubRepository({ slug, cloneUrl }, overrides)) as Repository,
    },
    agent: {
      coding: {
        run: (spec) => Promise.resolve(r('agent.coding.run', [spec], () => stubCodingResult(overrides)) as CodingRunResult),
        launch: (spec) => {
          const correlationId = `stub-run-${++launchSeq}`;
          // The resume payload IS the run result, so `agent.coding.run`
          // overrides control both `await run()` and `launch()` + pause.
          const result = {
            ...(r('agent.coding.run', [spec], () => stubCodingResult(overrides)) as CodingRunResult),
            runId: correlationId,
          };
          // Generic: any dispatch-able handle registers itself for pause-resume.
          return dispatchable(stubRunHandle(overrides, correlationId, result), opts.signals);
        },
      },
    },
    fileStorage: {
      upload: (input) =>
        Promise.resolve(
          r('fileStorage.upload', [input], () => ({
            fileId: 'stub-file',
            uploadUrl: 'https://storage.local/upload/stub-file',
            expiresAt: '2099-01-01T00:00:00Z',
            requiredHeaders: {},
          })) as UploadResponse,
        ),
      getDownloadUrl: (fileId) =>
        Promise.resolve(
          r('fileStorage.getDownloadUrl', [fileId], () => ({
            downloadUrl: `https://storage.local/download/${fileId}`,
            expiresAt: '2099-01-01T00:00:00Z',
          })) as DownloadUrlResponse,
        ),
      list: (listOpts) =>
        Promise.resolve(
          r('fileStorage.list', [listOpts], () => ({ files: [], limit: 20, offset: 0, hasMore: false })) as ListResponse,
        ),
      delete: (fileId) => Promise.resolve(r('fileStorage.delete', [fileId], () => undefined) as void),
      setVisibility: (fileId, visibility) =>
        Promise.resolve(
          r('fileStorage.setVisibility', [fileId, visibility], () => ({
            fileId,
            contentType: 'application/octet-stream',
            visibility,
            status: 'uploaded',
            createdAt: '2099-01-01T00:00:00Z',
            downloadRequestCount: 0,
          })) as FileMetadata,
        ),
    },
    withAttribution: () => client,
  };

  return client;
}
