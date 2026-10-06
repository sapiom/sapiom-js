import { randomUUID } from "node:crypto";
import { Transport, defaultTransport } from "../_client/index.js";
import { BrowserAutomationHttpError, ensureOk } from "./errors.js";

/** Reuse this key for retries of the same mutation and input. */
export interface BrowserMutation {
  idempotencyKey: string;
}
export interface ManagedSessionInput extends BrowserMutation {
  recording: boolean;
  tags?: string[];
  profileId?: string;
  idleTimeoutMinutes?: number;
  maxDurationMinutes?: number;
  headless?: false;
  adblock?: true;
  stealth?: true;
  captchaSolver?: true;
  proxy?: true;
}
/** A session accessed with its secret sessionId. Both a CDP client and a managed task can control it, at separate times. */
export interface ManagedBrowserSession {
  sessionId: string;
  cdpUrl: string;
  liveViewUrl?: string;
}
export interface BrowserSessionInfo {
  sessionId: string;
  status: string;
  tags: string[];
}
export interface BrowserCreationRecovery {
  status: "completed" | "cleanup_only" | "unknown";
  sessions: BrowserSessionInfo[];
}
export interface ManagedSessionSettlement {
  status: "terminated";
  settlement: "completed" | "pending";
}
export type BrowserTaskStatus =
  | "queued"
  | "running"
  | "paused"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "canceled";
export interface BrowserTask {
  taskId: string;
  sessionId: string;
  status: BrowserTaskStatus;
  result?: unknown;
  error?: unknown;
}
export interface BrowserTaskInput extends BrowserMutation {
  sessionId: string;
  instructions: string;
  url?: string;
  protectedValues?: Record<string, string>;
  /** Maximum task steps, from 1 to 80. */
  maxSteps: number;
  outputSchema: Record<string, unknown>;
}
export interface BrowserTaskControl extends BrowserMutation {
  taskId: string;
}
export interface BrowserTaskResponse extends BrowserTaskControl {
  requestId: string;
  response: string | boolean | Record<string, unknown>;
}
export interface BrowserTaskControlResult {
  taskId: string;
  sessionId: string;
  status: "success";
}
export interface BrowserInterventions {
  status: string;
  requests: Array<{ requestId: string; message?: string; inputType?: string }>;
}

/** Save browser state from a session. The profile becomes ready after the session closes. */
export interface BrowserProfileInput extends BrowserMutation {
  sessionId: string;
}
export interface BrowserProfile {
  profileId: string;
  /** Poll until ready before restoring this profile in another session. */
  status: string;
}
export interface BrowserProfileDelete extends BrowserMutation {
  profileId: string;
}
export interface BrowserRecordingControl extends BrowserMutation {
  sessionId: string;
}
export interface BrowserRecordings {
  items: Array<{ id: string; isPrimary: boolean }>;
}
export interface BrowserRecordingDelete {
  sessionId: string;
  /** A listed recording ID, or primary for the session's primary recording. */
  recordingId: string;
}
export interface BrowserRecordingFetch {
  sessionId: string;
  /** A single byte range, for example bytes=0-1023. */
  range?: string;
  /** Cancels the request and reading its response body. */
  signal?: AbortSignal;
}
export interface BrowserRecordingControlResult {
  status: "success";
}
export interface BrowserRecordingDeleteResult {
  status: "deleted" | "success";
}

/** The `:name` segments of a route template. */
type RouteParams<T extends string> =
  T extends `${string}:${infer P}/${infer Rest}`
    ? P | RouteParams<Rest>
    : T extends `${string}:${infer P}`
      ? P
      : never;

/**
 * A route template and the IDs for its `:name` segments. Session, task, and profile IDs
 * and creation keys are secret handles, so only the unfilled template reaches usage analytics.
 */
interface Route {
  template: string;
  ids: object;
}

const route = <T extends string>(
  template: T,
  ids: Record<RouteParams<T>, string>,
): Route => ({ template, ids });

/**
 * Fill each `:name` segment from the route's IDs. An ID must be a non-empty string and
 * not `.` or `..`: fetch resolves dot segments, which would send the request to another route.
 */
function pathOf({ template, ids }: Route): string {
  return template.replace(/:(\w+)/g, (_, name: string) => {
    const id = (ids as Record<string, unknown>)[name];
    if (typeof id !== "string" || id === "" || id === "." || id === "..")
      throw new BrowserAutomationHttpError(
        `${name} is required and must be a non-empty string other than . or ..`,
        400,
        { error: "invalid_id" },
      );
    return encodeURIComponent(id);
  });
}

/** Internal binding shared by the named namespace and an explicit client. */
export function managedBrowserApi(baseUrl: string, transport?: Transport) {
  const send = async (path: Route, init: RequestInit, errorPrefix: string) =>
    ensureOk(
      await (transport ?? defaultTransport()).fetch(
        `${baseUrl}/v1/browser${pathOf(path)}`,
        init,
        { analyticsUrl: `${baseUrl}/v1/browser${path.template}` },
      ),
      errorPrefix,
    );
  async function call<T>(
    method: string,
    path: Route,
    body?: unknown,
    key?: string,
  ): Promise<T> {
    if (
      key !== undefined &&
      (!/^[a-zA-Z0-9_.:-]{1,512}$/.test(key) || key === "." || key === "..")
    )
      throw new BrowserAutomationHttpError(
        "Invalid browser idempotency key",
        400,
        { error: "invalid_key" },
      );
    const response = await send(
      path,
      {
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(key !== undefined
            ? { "idempotency-key": key, "x-idempotency-key": key }
            : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      "Browser request failed",
    );
    return ((await response.json()) as { data: T }).data;
  }
  /** POST the input as the body, sending its idempotency key as a header. */
  const post = <T>(
    path: "/sessions" | "/profiles" | "/tasks",
    { idempotencyKey, ...body }: BrowserMutation,
  ) => call<T>("POST", route(path, {}), body, idempotencyKey);
  const taskControl = (
    operation: "pause" | "resume" | "respond",
    input: BrowserTaskControl,
    body: unknown = {},
  ) =>
    call<BrowserTaskControlResult>(
      "POST",
      route(`/tasks/:taskId/${operation}`, input),
      body,
      input.idempotencyKey,
    );
  const recordingControl = (
    operation: "pause" | "resume",
    input: BrowserRecordingControl,
  ) =>
    call<BrowserRecordingControlResult>(
      "POST",
      route(`/sessions/:sessionId/recordings/${operation}`, input),
      {},
      input.idempotencyKey,
    );
  return {
    sessions: {
      /** Create a session for CDP control or managed tasks. Defaults: idle 5 minutes, maximum 20 minutes. Existing sessions.create remains unchanged. */
      createManaged: (input: ManagedSessionInput) =>
        post<ManagedBrowserSession>("/sessions", input),
      get: (sessionId: string) =>
        call<BrowserSessionInfo>(
          "GET",
          route("/sessions/:sessionId", { sessionId }),
        ),
      /** Recover with the original API key and creation key. Never creates or pays again. */
      recover: (idempotencyKey: string) =>
        call<BrowserCreationRecovery>(
          "GET",
          route("/sessions/recovery/:idempotencyKey", { idempotencyKey }),
        ),
      /** Close only sessions created with createManaged. Retry when settlement is pending. */
      closeManaged: (sessionId: string) =>
        call<ManagedSessionSettlement>(
          "DELETE",
          route("/sessions/:sessionId", { sessionId }),
        ),
    },
    profiles: {
      /** Save an unrecorded session without protected inputs. Close it to finish the save. */
      save: (input: BrowserProfileInput) =>
        post<BrowserProfile>("/profiles", input),
      get: (profileId: string) =>
        call<BrowserProfile>(
          "GET",
          route("/profiles/:profileId", { profileId }),
        ),
      /** Reuse the original key if deletion needs reconciliation. */
      delete: (input: BrowserProfileDelete) =>
        call<{ status: "deleted" }>(
          "DELETE",
          route("/profiles/:profileId", input),
          undefined,
          input.idempotencyKey,
        ),
    },
    recordings: {
      list: (sessionId: string) =>
        call<BrowserRecordings>(
          "GET",
          route("/sessions/:sessionId/recordings", { sessionId }),
        ),
      pause: (input: BrowserRecordingControl) =>
        recordingControl("pause", input),
      resume: (input: BrowserRecordingControl) =>
        recordingControl("resume", input),
      delete: (input: BrowserRecordingDelete) =>
        call<BrowserRecordingDeleteResult>(
          "DELETE",
          route("/sessions/:sessionId/recordings/:recordingId", input),
        ),
      /** Stream the primary video through Sapiom. The response retains range headers and HTTP 206. */
      fetch: (input: BrowserRecordingFetch) =>
        send(
          route("/sessions/:sessionId/recordings/primary/fetch", input),
          {
            method: "GET",
            headers: {
              accept: "video/mp4",
              ...(input.range ? { range: input.range } : {}),
            },
            signal: input.signal,
          },
          "Browser recording request failed",
        ),
    },
    tasks: {
      /** Start one task using its secret sessionId. Stop client CDP actions before this call. */
      start: (input: BrowserTaskInput) => post<BrowserTask>("/tasks", input),
      get: (taskId: string) =>
        call<BrowserTask>("GET", route("/tasks/:taskId", { taskId })),
      /** Request pause. Confirm paused state before a CDP client or person acts. */
      pause: (input: BrowserTaskControl) => taskControl("pause", input),
      /** Stop client CDP actions before resuming the task. */
      resume: (input: BrowserTaskControl) => taskControl("resume", input),
      interventions: (taskId: string) =>
        call<BrowserInterventions>(
          "GET",
          route("/tasks/:taskId/interventions", { taskId }),
        ),
      respond: (input: BrowserTaskResponse) =>
        taskControl("respond", input, {
          requestId: input.requestId,
          response: input.response,
        }),
    },
  };
}

/** The managed sessions, tasks, profiles, and recordings API bound to one transport. */
export type ManagedBrowserApi = ReturnType<typeof managedBrowserApi>;

export type WithManagedSessionInput = Omit<
  ManagedSessionInput,
  "idempotencyKey"
> & { idempotencyKey?: string };

export interface WithManagedSessionOptions {
  /** Called when a close has not completed within the retry window, so the caller can retry closeManaged later. */
  onPendingClose?: (sessionId: string) => void | Promise<void>;
}

type ManagedSessionLifecycle = Pick<
  ManagedBrowserApi["sessions"],
  "createManaged" | "recover" | "closeManaged"
>;

const CREATE_RETRY_WINDOW_MS = 90_000;
const CREATE_RETRY_INITIAL_DELAY_MS = 2_000;
const CREATE_RETRY_MAX_DELAY_MS = 10_000;
const RECOVERY_WINDOW_MS = 120_000;
const RECOVERY_INTERVAL_MS = 10_000;
const CLOSE_WINDOW_MS = 90_000;
const CLOSE_INTERVAL_MS = 5_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function isUncertain(error: unknown): boolean {
  return (
    !(error instanceof BrowserAutomationHttpError) ||
    error.status === 429 ||
    error.status >= 500 ||
    error.code === "browser_outcome_unknown"
  );
}

async function closeWithRetry(
  sessions: ManagedSessionLifecycle,
  sessionId: string,
  options?: WithManagedSessionOptions,
): Promise<void> {
  const deadline = Date.now() + CLOSE_WINDOW_MS;
  while (Date.now() <= deadline) {
    try {
      const result = await sessions.closeManaged(sessionId);
      if (result.settlement === "completed") return;
      if (Date.now() + CLOSE_INTERVAL_MS > deadline) break;
    } catch (error) {
      if (error instanceof BrowserAutomationHttpError && error.status === 404) {
        return;
      }
      const retryable =
        isUncertain(error) ||
        (error instanceof BrowserAutomationHttpError &&
          (error.status === 409 || error.status >= 500));
      if (!retryable || Date.now() + CLOSE_INTERVAL_MS > deadline) break;
    }
    await sleep(CLOSE_INTERVAL_MS);
  }

  try {
    await options?.onPendingClose?.(sessionId);
  } catch {
    /* swallow */
  }
}

export async function runManagedSession<T>(
  sessions: ManagedSessionLifecycle,
  input: WithManagedSessionInput,
  fn: (session: ManagedBrowserSession) => Promise<T>,
  options?: WithManagedSessionOptions,
): Promise<T> {
  const createInput: ManagedSessionInput = {
    ...input,
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
  };
  const createDeadline = Date.now() + CREATE_RETRY_WINDOW_MS;
  let delay = CREATE_RETRY_INITIAL_DELAY_MS;
  let session: ManagedBrowserSession | undefined;
  let creationError: unknown;

  while (session === undefined) {
    try {
      session = await sessions.createManaged(createInput);
    } catch (error) {
      if (!isUncertain(error)) throw error;
      if (Date.now() + delay > createDeadline) {
        creationError = error;
        break;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, CREATE_RETRY_MAX_DELAY_MS);
    }
  }

  if (session === undefined) {
    const recoveryDeadline = Date.now() + RECOVERY_WINDOW_MS;
    try {
      while (Date.now() <= recoveryDeadline) {
        let recovery;
        try {
          recovery = await sessions.recover(createInput.idempotencyKey);
        } catch (error) {
          if (!isUncertain(error)) break;
          if (Date.now() + RECOVERY_INTERVAL_MS > recoveryDeadline) break;
          await sleep(RECOVERY_INTERVAL_MS);
          continue;
        }

        if (
          recovery.status === "completed" ||
          recovery.status === "cleanup_only"
        ) {
          for (const recoveredSession of recovery.sessions) {
            await closeWithRetry(sessions, recoveredSession.sessionId, options);
          }
          break;
        }
        if (recovery.status !== "unknown") break;
        if (Date.now() + RECOVERY_INTERVAL_MS > recoveryDeadline) break;
        await sleep(RECOVERY_INTERVAL_MS);
      }
    } catch {
      /* Preserve the creation error. */
    }
    throw creationError;
  }

  try {
    return await fn(session);
  } finally {
    await closeWithRetry(sessions, session.sessionId, options);
  }
}
