export const openCodeTransportErrorCodes = [
  "access_denied",
  "access_expired",
  "authentication_required",
  "runtime_start_failed",
  "runtime_exited",
  "native_history_missing",
  "transport_unavailable",
] as const;
export type OpenCodeTransportErrorCode =
  (typeof openCodeTransportErrorCodes)[number];

export const openCodeStartupReasons = [
  "executable-not-found",
  "permission-denied",
  "launch-failed",
  "exited",
  "timed-out",
  "cancelled",
] as const;
export type OpenCodeStartupReason = (typeof openCodeStartupReasons)[number];

export type OpenCodeTransportAction =
  | "sign_in"
  | "open_account"
  | "reconnect"
  | "open_session";

export interface OpenCodeTransportFailure {
  code: OpenCodeTransportErrorCode;
  message: string;
  retryable: boolean;
  action: OpenCodeTransportAction;
  startupReason?: OpenCodeStartupReason;
}

export interface OpenCodeTransportErrorBody {
  error: OpenCodeTransportFailure;
}

export interface OpenCodeStudioErrorEvent {
  type: "studio.error";
  properties: OpenCodeTransportFailure;
}

const fixedFailures = {
  access_denied: {
    code: "access_denied",
    message: "Assistant access is not available for this account.",
    retryable: false,
    action: "open_account",
  },
  access_expired: {
    code: "access_expired",
    message: "Assistant access expired. Check your account access and try again.",
    retryable: false,
    action: "open_account",
  },
  authentication_required: {
    code: "authentication_required",
    message: "Sign in to Studio to use Assistant.",
    retryable: false,
    action: "sign_in",
  },
  runtime_exited: {
    code: "runtime_exited",
    message: "Assistant stopped. Reconnect to load the saved conversation.",
    retryable: true,
    action: "reconnect",
  },
  native_history_missing: {
    code: "native_history_missing",
    message:
      "The saved Assistant conversation is unavailable. The Studio session is still available.",
    retryable: false,
    action: "open_session",
  },
  transport_unavailable: {
    code: "transport_unavailable",
    message:
      "Assistant is temporarily unavailable. Reconnect before sending another message.",
    retryable: true,
    action: "reconnect",
  },
} as const satisfies Partial<
  Record<OpenCodeTransportErrorCode, OpenCodeTransportFailure>
>;

const startupFailures = {
  "executable-not-found": {
    message:
      "Studio's OpenCode runtime is missing. Update or reinstall Studio, then retry.",
    retryable: false,
    action: "open_settings",
  },
  "permission-denied": {
    message:
      "Studio cannot launch its OpenCode runtime because the executable is not permitted. Check the installation permissions or reinstall Studio, then retry.",
    retryable: false,
    action: "open_settings",
  },
  "launch-failed": {
    message:
      "Studio could not launch its OpenCode runtime. Retry, then update or reinstall Studio if the problem continues.",
    retryable: true,
    action: "reconnect",
  },
  exited: {
    message:
      "OpenCode exited before it became ready. Retry, then update or reinstall Studio if the problem continues.",
    retryable: true,
    action: "reconnect",
  },
  "timed-out": {
    message: "OpenCode took too long to start. Retry the connection.",
    retryable: true,
    action: "reconnect",
  },
  cancelled: {
    message: "OpenCode startup was cancelled.",
    retryable: true,
    action: "reconnect",
  },
} as const satisfies Record<
  OpenCodeStartupReason,
  Pick<OpenCodeTransportFailure, "message" | "retryable" | "action">
>;

const genericStartup = {
  message: "Studio could not start its OpenCode runtime. Retry the connection.",
  retryable: true,
  action: "reconnect",
} as const;

export function openCodeTransportFailure(
  code: Exclude<OpenCodeTransportErrorCode, "runtime_start_failed">,
): OpenCodeTransportFailure;
export function openCodeTransportFailure(
  code: "runtime_start_failed",
  startupReason?: OpenCodeStartupReason,
): OpenCodeTransportFailure;
export function openCodeTransportFailure(
  code: OpenCodeTransportErrorCode,
  startupReason?: OpenCodeStartupReason,
): OpenCodeTransportFailure {
  if (code !== "runtime_start_failed") return { ...fixedFailures[code] };
  const definition = startupReason
    ? startupFailures[startupReason]
    : genericStartup;
  return {
    code,
    ...definition,
    ...(startupReason ? { startupReason } : {}),
  };
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Accept only the exact shared combination; arbitrary server text is untrusted. */
export function parseOpenCodeTransportFailure(
  value: unknown,
): OpenCodeTransportFailure | null {
  const candidate = record(value);
  if (!candidate) return null;
  const keys = Object.keys(candidate);
  if (
    !keys.every((key) =>
      ["code", "message", "retryable", "action", "startupReason"].includes(
        key,
      ),
    ) ||
    !openCodeTransportErrorCodes.includes(
      candidate.code as OpenCodeTransportErrorCode,
    )
  )
    return null;
  const code = candidate.code as OpenCodeTransportErrorCode;
  let expected: OpenCodeTransportFailure;
  if (code === "runtime_start_failed") {
    if (
      candidate.startupReason !== undefined &&
      !openCodeStartupReasons.includes(
        candidate.startupReason as OpenCodeStartupReason,
      )
    )
      return null;
    expected = openCodeTransportFailure(
      code,
      candidate.startupReason as OpenCodeStartupReason | undefined,
    );
  } else {
    if (candidate.startupReason !== undefined) return null;
    expected = openCodeTransportFailure(code);
  }
  return JSON.stringify(candidate) === JSON.stringify(expected) ? expected : null;
}

export function parseOpenCodeTransportErrorBody(
  value: unknown,
): OpenCodeTransportFailure | null {
  const body = record(value);
  return body && Object.keys(body).length === 1
    ? parseOpenCodeTransportFailure(body.error)
    : null;
}

export function parseOpenCodeStudioErrorEvent(
  value: unknown,
): OpenCodeTransportFailure | null {
  const event = record(value);
  return event &&
    Object.keys(event).length === 2 &&
    event.type === "studio.error"
    ? parseOpenCodeTransportFailure(event.properties)
    : null;
}
