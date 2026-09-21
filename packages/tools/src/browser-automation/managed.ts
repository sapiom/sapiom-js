import { Transport, defaultTransport } from "../_client/index.js";
import { BrowserAutomationHttpError, ensureOk } from "./errors.js";

/** Reuse this key for retries of the same mutation and input. */
export interface BrowserMutation {
  idempotencyKey: string;
}
export interface ManagedSessionInput extends BrowserMutation {
  recording: boolean;
  tags?: string[];
  profileName?: string;
  idleTimeoutMinutes?: number;
  maxDurationMinutes?: number;
  headless?: false;
  adblock?: true;
  stealth?: true;
  captchaSolver?: true;
  proxy?: true;
}
/** A tenant-owned session. Both a CDP client and a managed task can control it, at separate times. */
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
export interface BrowserSessionList {
  sessions: BrowserSessionInfo[];
  totalPages: number;
}
export interface BrowserCreationRecovery {
  status: "completed" | "cleanup_only" | "unknown";
  sessions: BrowserSessionInfo[];
}
export interface ManagedSessionSettlement {
  status: "terminated";
  settlement?: "completed" | "pending";
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

/** Internal binding shared by the named namespace and an explicit client. */
export function managedBrowserApi(baseUrl: string, transport?: Transport) {
  const segment = (id: string) => encodeURIComponent(id);
  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<T> {
    if (key !== undefined && !/^[a-zA-Z0-9_.:-]{1,512}$/.test(key))
      throw new BrowserAutomationHttpError(
        "Invalid browser idempotency key",
        400,
        { error: "invalid_key" },
      );
    const response = await ensureOk(
      await (transport ?? defaultTransport()).fetch(
        `${baseUrl}/v1/browser${path}`,
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
      ),
      "Browser request failed",
    );
    return ((await response.json()) as { data: T }).data;
  }
  const control = (
    operation: string,
    input: BrowserTaskControl,
    body: unknown = {},
  ) =>
    call<BrowserTaskControlResult>(
      "POST",
      `/tasks/${segment(input.taskId)}/${operation}`,
      body,
      input.idempotencyKey,
    );
  return {
    sessions: {
      /** Create a session for the owned API. Existing sessions.create remains unchanged. */
      createManaged(
        input: ManagedSessionInput,
      ): Promise<ManagedBrowserSession> {
        const { idempotencyKey, ...body } = input;
        return call(
          "POST",
          "/sessions",
          { idleTimeoutMinutes: 5, maxDurationMinutes: 20, ...body },
          idempotencyKey,
        );
      },
      get: (sessionId: string) =>
        call<BrowserSessionInfo>("GET", `/sessions/${segment(sessionId)}`),
      list: (input: { tags?: string[]; page?: number } = {}) =>
        call<BrowserSessionList>(
          "GET",
          `/sessions?${new URLSearchParams({ tags: (input.tags ?? []).join(","), page: String(input.page ?? 1) })}`,
        ),
      /** Find an uncertain create, including one without caller tags. Never creates or pays again. */
      recover: (idempotencyKey: string) =>
        call<BrowserCreationRecovery>(
          "GET",
          `/sessions/recovery/${segment(idempotencyKey)}`,
        ),
      /** Close only sessions created with createManaged. Retry when settlement is pending. */
      closeManaged: (sessionId: string) =>
        call<ManagedSessionSettlement>(
          "DELETE",
          `/sessions/${segment(sessionId)}`,
        ),
    },
    tasks: {
      /** Start one task in an owned session. Stop client CDP actions before this call. */
      start(input: BrowserTaskInput): Promise<BrowserTask> {
        const { idempotencyKey, ...body } = input;
        return call("POST", "/tasks", body, idempotencyKey);
      },
      get: (taskId: string) =>
        call<BrowserTask>("GET", `/tasks/${segment(taskId)}`),
      /** Request pause. Confirm paused state before a CDP client or person acts. */
      pause: (input: BrowserTaskControl) => control("pause", input),
      /** Stop client CDP actions before resuming the task. */
      resume: (input: BrowserTaskControl) => control("resume", input),
      interventions: (taskId: string) =>
        call<BrowserInterventions>(
          "GET",
          `/tasks/${segment(taskId)}/interventions`,
        ),
      respond: (input: BrowserTaskResponse) =>
        control("respond", input, {
          requestId: input.requestId,
          response: input.response,
        }),
    },
  };
}
