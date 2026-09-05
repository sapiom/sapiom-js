/**
 * The App Links REST transport shared by `sapiom_dev_app_publish` (app-publish.ts)
 * and the management tools (app-manage.ts): one JSON call, the wire body parsed,
 * and the result envelope every App Links tool answers in.
 *
 * Deliberately NOT a `GatewayClient`: its error mapping keeps only `HTTP_<status>`
 * and drops the body's `code`, and the App Links codes (`BUNDLE_BINARY_FILE`,
 * `APP_LINK_MANAGEMENT_PERMISSION_REQUIRED`, …) carry the detail that makes a
 * failure fixable. Error MAPPING stays in each tool module — the copy differs
 * (publish is step-aware; a settings change is not) — but the transport, the
 * body parsing, the wire shape and the envelope are one thing, and lived here
 * once the second module needed them.
 *
 * Extracted from app-publish.ts (SAP-3178). It lives in its own module rather
 * than being exported from app-publish.ts so a tool module never imports another
 * tool module; `shared.ts` is not used because its `fail` keys off
 * `AgentOperationError`, while every App Links tool throws `PreviewOperationError`
 * (the sandbox-preview family these tools belong to).
 */
import { PreviewOperationError } from "@sapiom/sandbox-preview";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

// ─── Wire shapes ─────────────────────────────────────────────────────────────

/**
 * The backend's `AppLinkResponseDto`, narrowed to what these tools read. Fields
 * the 2.8-era publish response did not carry are optional so an older server
 * still parses.
 */
export interface AppLinkWire {
  id: string;
  slug: string;
  name: string;
  visibility: string;
  url: string;
  description?: string | null;
  webhooksEnabled?: boolean;
  wakeRateLimitPerHour?: number;
  dailySpendCapUsd?: string | null;
  wakeStatus?: string;
  /** Null until a bundle is activated; set on the publish response. */
  bundleSha256?: string | null;
  updatedAt?: string;
}

/** `GET /v1/app-links` → `{ items }`. */
export interface AppLinkListWire {
  items: AppLinkWire[];
}

/** The public error boundary's body: `statusCode`, `code`, `message`, plus per-code detail. */
export interface ErrorBody {
  code?: unknown;
  message?: unknown;
  /** `BUNDLE_BINARY_FILE`: the offending FILE path, not the request URL. */
  path?: unknown;
  bytes?: unknown;
  maxBytes?: unknown;
}

// ─── Transport ───────────────────────────────────────────────────────────────

/**
 * What one call produced. `network` is the fetch itself failing (DNS, refused,
 * TLS) — nothing reached the server; `response` is anything it answered,
 * success or not, with the body parsed when it was JSON and kept raw when not.
 */
export type AppLinksResponse =
  | { kind: "response"; status: number; ok: boolean; data: unknown }
  | { kind: "network"; url: string; cause: unknown };

/**
 * One JSON call against the backend's App Links REST API, authenticated with the
 * cached `sapiom_authenticate` credential as `x-api-key`.
 *
 * The URL is concatenated, not `new URL(route, base)`: a custom `apiURL` carrying
 * a base path (a local proxy, a tunnel) would have it silently dropped by the
 * latter. A body-less method (`GET`, `DELETE`) sends no body and no content-type.
 */
export async function appLinksFetch(
  apiURL: string,
  apiKey: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<AppLinksResponse> {
  const url = `${apiURL.replace(/\/+$/, "")}${route}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "x-api-key": apiKey,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    return { kind: "network", url, cause };
  }
  const text = await res.text();
  return {
    kind: "response",
    status: res.status,
    ok: res.ok,
    data: text ? safeParse(text) : undefined,
  };
}

export function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The body's `message`, which NestJS validation returns as an array of one line per field. */
export function messageFrom(body: ErrorBody): string | undefined {
  const m = body.message;
  if (Array.isArray(m)) return m.join("; ");
  if (typeof m === "string") return m;
  return undefined;
}

/** The body's `code` when it is one, else `undefined`. */
export function codeFrom(data: unknown): string | undefined {
  const code = ((data ?? {}) as ErrorBody).code;
  return typeof code === "string" ? code : undefined;
}

/** A wire body that is usable as an app link, or `null`. */
export function asAppLink(data: unknown): AppLinkWire | null {
  const link = data as AppLinkWire | undefined;
  const usable =
    typeof link?.id === "string" &&
    link.id !== "" &&
    typeof link.url === "string";
  return usable ? (link as AppLinkWire) : null;
}

/**
 * Where a third party POSTs once webhooks are on. The `/hook` prefix is stripped
 * by the host before the app sees the request, so an app receives
 * `/slack/interactivity` for a POST to `…/hook/slack/interactivity`.
 */
export function webhookUrlOf(link: Pick<AppLinkWire, "url">): string {
  return `${link.url.replace(/\/+$/, "")}/hook/<path>`;
}

// ─── Result envelope ─────────────────────────────────────────────────────────

export function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * The structured `{"error": {code, message, hint?}}` envelope. The JSON matters
 * beyond readability: `registerTool` parses `error.code` out of it to classify
 * the `tool.call` analytics event.
 */
export function fail(err: unknown): ToolResult {
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

export const NOT_AUTHED = fail(
  new PreviewOperationError({
    code: "NOT_AUTHENTICATED",
    message: "Not authenticated. Run sapiom_authenticate first.",
  }),
);
