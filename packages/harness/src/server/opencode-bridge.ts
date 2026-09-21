import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import express, { type Request, type Response, type Router } from "express";
import rateLimit, { MemoryStore } from "express-rate-limit";
import type { ResolvedEnvironment } from "@sapiom/mcp/auth";
import type {
  AssistantAccess,
  AssistantGrant,
} from "../core/assistant-access.js";
import {
  fetchOpenCodeModelResponse,
  openCodeModelCompletionToken,
} from "./opencode-model-response.js";

type Access = Pick<AssistantAccess, "get" | "subscribe">;
interface Registration {
  digest: Buffer;
  grant: AssistantGrant;
  requests: Set<AbortController>;
}
export interface OpenCodeBridgeCredential {
  id: string;
  token: string;
  revoke(): void;
}
const digest = (value: string) => createHash("sha256").update(value).digest();
const sameAuthority = (a: AssistantGrant, b: AssistantGrant) =>
  a.userId === b.userId &&
  a.tenantId === b.tenantId &&
  a.identityRevision === b.identityRevision &&
  a.environment.name === b.environment.name &&
  a.environment.apiURL === b.environment.apiURL &&
  a.environment.credentials?.apiKey === b.environment.credentials?.apiKey;

type BridgeErrorType =
  | "authentication_error"
  | "invalid_request_error"
  | "permission_error"
  | "rate_limit_error"
  | "server_error"
  | "upstream_error";

function sendBridgeError(
  res: Response,
  status: number,
  error: { message: string; type: BridgeErrorType; code: string },
  retryAfter?: string,
): void {
  res.setHeader("Cache-Control", "no-store");
  if (retryAfter) res.setHeader("Retry-After", retryAfter);
  res.status(status).json({ error });
}

function upstreamError(status: number): {
  message: string;
  type: BridgeErrorType;
  code: string;
} {
  switch (status) {
    case 400:
      return {
        message: "The Assistant request was rejected as invalid.",
        type: "invalid_request_error",
        code: "assistant_invalid_request",
      };
    case 401:
      return {
        message: "Studio credentials were rejected. Sign in again.",
        type: "authentication_error",
        code: "assistant_authentication_failed",
      };
    case 403:
      return {
        message: "The Assistant service denied this request.",
        type: "permission_error",
        code: "assistant_permission_denied",
      };
    case 413:
      return {
        message: "The Assistant request is too large.",
        type: "invalid_request_error",
        code: "assistant_request_too_large",
      };
    case 429:
      return {
        message: "The Assistant service is rate limited.",
        type: "rate_limit_error",
        code: "assistant_rate_limited",
      };
    default:
      return status >= 500
        ? {
            message: "The Assistant service is temporarily unavailable.",
            type: "server_error",
            code: "assistant_service_unavailable",
          }
        : {
            message: "The Assistant service request failed.",
            type: "upstream_error",
            code: "assistant_upstream_error",
          };
  }
}

/** Only forward the standardized header on statuses that define its use. */
function validatedRetryAfter(
  response: globalThis.Response,
): string | undefined {
  if (![413, 429, 503].includes(response.status)) return;
  const value = response.headers.get("retry-after");
  if (!value) return;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (Number.isSafeInteger(seconds)) return value;
    return;
  }
  // HTTP senders generate IMF-fixdate. A canonical round trip rejects the
  // obsolete/lenient date forms accepted by Date.parse and mismatched days.
  const timestamp = Date.parse(value);
  if (
    Number.isFinite(timestamp) &&
    timestamp > Date.now() &&
    new Date(timestamp).toUTCString() === value
  )
    return value;
}

/** Destinations come exclusively from Studio's signed-in environment. */
export function assistantUpstreams(env: ResolvedEnvironment): {
  llm: URL;
  mcp: URL;
} {
  const configured =
    env.services.llm ??
    (env.name === "production" && env.apiURL === "https://api.sapiom.ai"
      ? "https://router.sapiom.ai"
      : undefined);
  if (!configured)
    throw new Error(
      "Assistant model endpoint is not configured for this environment",
    );
  const root = (value: string): URL => {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        ))
    ) {
      throw new Error("Invalid Assistant service configuration");
    }
    return url;
  };
  return {
    llm: new URL("/v1/responses", root(configured)),
    mcp: new URL("/v1/mcp", root(env.apiURL)),
  };
}

/** Runtime-only transport. Browser boot authentication is never accepted here. */
export class OpenCodeBridge {
  readonly router: Router = express.Router();
  private registrations = new Map<string, Registration>();
  private readonly authenticationAttempts = new MemoryStore();
  private unsubscribe: () => void;

  constructor(
    private readonly access: Access,
    readonly model = "gpt-luna",
  ) {
    this.unsubscribe = access.subscribe(() => {
      const grant = access.get();
      for (const [id, entry] of this.registrations) {
        if (!grant || !sameAuthority(entry.grant, grant)) this.revoke(id);
      }
    });
    // Share the peer-IP budget across both routes so rotating runtime IDs cannot
    // bypass it. Count only local runtime credential rejection: upstream denials
    // must still reach sign-in recovery, including on long-lived MCP streams.
    const authenticationRateLimit = rateLimit({
      windowMs: 60_000,
      max: 120,
      store: this.authenticationAttempts,
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: true,
      requestWasSuccessful: (_req, res) =>
        res.locals.assistantRuntimeAuthenticationFailed !== true,
      handler: (_req, res) => {
        sendBridgeError(res, 429, {
          message:
            "Too many failed Assistant authentication attempts. Try again shortly.",
          type: "rate_limit_error",
          code: "assistant_runtime_rate_limited",
        });
      },
    });
    const raw = express.raw({ type: () => true, limit: "4mb" });
    this.router.all(
      "/:id/llm/v1/responses",
      authenticationRateLimit,
      raw,
      (req, res) => {
        void this.forward(req, res, "llm");
      },
    );
    this.router.all("/:id/mcp", authenticationRateLimit, raw, (req, res) => {
      void this.forward(req, res, "mcp");
    });
    this.router.use((_req, res) => {
      res.status(404).json({ error: "Unknown Assistant service route" });
    });
  }

  issue(): OpenCodeBridgeCredential {
    const grant = this.access.get();
    if (!grant) throw new Error("Assistant access is unavailable");
    assistantUpstreams(grant.environment);
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.registrations.set(id, {
      digest: digest(token),
      grant,
      requests: new Set(),
    });
    return { id, token, revoke: () => this.revoke(id) };
  }

  close(): void {
    this.unsubscribe();
    for (const id of this.registrations.keys()) this.revoke(id);
    this.authenticationAttempts.shutdown();
  }

  private revoke(id: string): void {
    const entry = this.registrations.get(id);
    this.registrations.delete(id);
    for (const request of entry?.requests ?? []) request.abort();
  }

  private async forward(
    req: Request,
    res: Response,
    service: "llm" | "mcp",
  ): Promise<void> {
    const entry = this.registrations.get(req.params.id!);
    const token = req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
    const grant = this.access.get();
    if (
      !entry ||
      token.length > 256 ||
      !timingSafeEqual(entry.digest, digest(token))
    ) {
      res.locals.assistantRuntimeAuthenticationFailed = true;
      sendBridgeError(res, 401, {
        message: "Invalid Assistant runtime credential.",
        type: "authentication_error",
        code: "assistant_runtime_credential_invalid",
      });
      return;
    }
    if (!grant || !sameAuthority(entry.grant, grant)) {
      this.revoke(req.params.id!);
      res.locals.assistantRuntimeAuthenticationFailed = true;
      sendBridgeError(res, 403, {
        message: "Assistant access is unavailable.",
        type: "permission_error",
        code: "assistant_access_unavailable",
      });
      return;
    }
    if (
      Object.keys(req.query).length ||
      !(service === "llm" ? ["POST"] : ["POST", "GET", "DELETE"]).includes(
        req.method,
      )
    ) {
      sendBridgeError(res, 400, {
        message: "Unsupported Assistant service request.",
        type: "invalid_request_error",
        code: "assistant_request_unsupported",
      });
      return;
    }
    const abort = new AbortController();
    entry.requests.add(abort);
    const disconnected = () => abort.abort();
    res.once("close", disconnected);
    try {
      const upstream = assistantUpstreams(grant.environment)[service];
      const key = grant.environment.credentials!.apiKey;
      const headers = new Headers({
        "Accept-Encoding": "identity",
        Accept: req.header("Accept") ?? "application/json",
        "Content-Type": "application/json",
        "x-api-key": key,
      });
      // Queued MCP tools close the POST stream and deliver results through
      // GET replay. Its cursor must survive the credential bridge.
      for (const name of [
        "mcp-session-id",
        "mcp-protocol-version",
        "last-event-id",
      ]) {
        if (service === "mcp" && req.header(name))
          headers.set(name, req.header(name)!);
      }
      let body = req.method === "POST" ? (req.body as Buffer) : undefined;
      let streamingModel = false;
      let completionToken: string | undefined;
      if (service === "llm") {
        let request: Record<string, unknown>;
        try {
          request = JSON.parse(body?.toString("utf8") ?? "");
        } catch {
          sendBridgeError(res, 400, {
            message: "Invalid model request.",
            type: "invalid_request_error",
            code: "assistant_model_request_invalid",
          });
          return;
        }
        if (!request || typeof request !== "object" || Array.isArray(request)) {
          sendBridgeError(res, 400, {
            message: "Invalid model request.",
            type: "invalid_request_error",
            code: "assistant_model_request_invalid",
          });
          return;
        }
        body = Buffer.from(
          JSON.stringify({ ...request, model: this.model, store: false }),
        );
        streamingModel = request.stream === true;
        completionToken = openCodeModelCompletionToken(request);
      }
      const request = () =>
        fetch(upstream, {
          method: req.method,
          headers,
          body: body as Uint8Array<ArrayBuffer> | undefined,
          redirect: "error",
          signal: abort.signal,
        });
      const response = streamingModel
        ? await fetchOpenCodeModelResponse(
            request,
            abort.signal,
            completionToken,
          )
        : await request();
      if (!response.ok) {
        await response.body?.cancel();
        // Preserve status-based client policy, including MCP's optional 405,
        // while replacing all credential-bearing upstream content.
        sendBridgeError(
          res,
          response.status,
          upstreamError(response.status),
          validatedRetryAfter(response),
        );
        return;
      }
      res.status(response.status);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Accel-Buffering", "no");
      for (const name of [
        "content-type",
        "mcp-session-id",
        "mcp-protocol-version",
      ]) {
        const value = response.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      res.flushHeaders();
      if (response.body) {
        await pipeline(Readable.fromWeb(response.body as never), res, {
          signal: abort.signal,
        });
      } else res.end();
    } catch {
      if (!res.headersSent && !res.destroyed) {
        sendBridgeError(res, 502, {
          message: "Assistant connection failed.",
          type: "server_error",
          code: "assistant_connection_failed",
        });
      } else res.destroy();
    } finally {
      res.off("close", disconnected);
      entry.requests.delete(abort);
    }
  }
}
