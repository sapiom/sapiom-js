import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import express, { type Request, type Response, type Router } from "express";
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
  a.identityRevision === b.identityRevision &&
  a.environment.name === b.environment.name &&
  a.environment.apiURL === b.environment.apiURL &&
  a.environment.credentials?.apiKey === b.environment.credentials?.apiKey;

/** Destinations come exclusively from Studio's signed-in environment. */
export function assistantUpstreams(env: ResolvedEnvironment): {
  llm: URL;
  mcp: URL;
} {
  const configured =
    env.services.llm ??
    (env.name === "production" && env.apiURL === "https://api.sapiom.ai"
      ? "https://llm.services.sapiom.ai"
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
    llm: new URL("/v2/openai/v1/chat/completions", root(configured)),
    mcp: new URL("/v1/mcp", root(env.apiURL)),
  };
}

/** Runtime-only transport. Browser boot authentication is never accepted here. */
export class OpenCodeBridge {
  readonly router: Router = express.Router();
  private registrations = new Map<string, Registration>();
  private unsubscribe: () => void;

  constructor(
    private readonly access: Access,
    readonly model = "smart",
  ) {
    this.unsubscribe = access.subscribe(() => {
      const grant = access.get();
      for (const [id, entry] of this.registrations) {
        if (!grant || !sameAuthority(entry.grant, grant)) this.revoke(id);
      }
    });
    const raw = express.raw({ type: () => true, limit: "4mb" });
    this.router.all(
      "/:id/llm/v2/openai/v1/chat/completions",
      raw,
      (req, res) => {
        void this.forward(req, res, "llm");
      },
    );
    this.router.all("/:id/mcp", raw, (req, res) => {
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
      res.status(401).json({ error: "Invalid Assistant runtime credential" });
      return;
    }
    if (!grant || !sameAuthority(entry.grant, grant)) {
      this.revoke(req.params.id!);
      res.status(403).json({ error: "Assistant access is unavailable" });
      return;
    }
    if (
      Object.keys(req.query).length ||
      !(service === "llm" ? ["POST"] : ["POST", "GET", "DELETE"]).includes(
        req.method,
      )
    ) {
      res.status(400).json({ error: "Unsupported Assistant service request" });
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
        ...(service === "llm"
          ? { "x-sapiom-api-key": key, "x-sapiom-model": this.model }
          : { "x-api-key": key }),
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
          res.status(400).json({ error: "Invalid model request" });
          return;
        }
        if (!request || typeof request !== "object" || Array.isArray(request)) {
          res.status(400).json({ error: "Invalid model request" });
          return;
        }
        body = Buffer.from(JSON.stringify({ ...request, model: this.model }));
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
        // MCP uses 405 to decline optional notification streams or session
        // cleanup; clients handle that without treating it as a service outage.
        const status =
          response.status === 401 ||
          (service === "mcp" && response.status === 405)
            ? response.status
            : 502;
        res.status(status).json({
          error:
            response.status === 401
              ? "Studio credentials were rejected. Sign in again, then retry."
              : "The Assistant service request failed. Please retry.",
        });
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
        res
          .status(502)
          .json({ error: "Assistant connection failed. Please retry." });
      } else res.destroy();
    } finally {
      res.off("close", disconnected);
      entry.requests.delete(abort);
    }
  }
}
