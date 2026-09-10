import express, { type Request, type Response, type Router } from "express";
import {
  OpenCodeAssociations,
  isConversationId,
} from "../core/opencode-association.js";
import {
  OpenCodeAccessError,
  type OpenCodeHost,
} from "../core/opencode-host.js";
import { createBootTokenMiddleware } from "./auth.js";
import { streamOpenCodeEvents } from "./opencode-events.js";
import { OpenCodeFinalResponse } from "../core/opencode-final-response.js";
import { openCodeCompletionPrompt } from "../shared/opencode-completion.js";

export function createOpenCodeRouter(
  host: Pick<OpenCodeHost, "ensure">,
  bootToken: string,
): Router {
  const router = express.Router();
  const associations = new OpenCodeAssociations();
  const finalResponse = new OpenCodeFinalResponse();
  router.use(
    createBootTokenMiddleware(bootToken),
    express.json({ limit: "1mb" }),
  );
  router.all("/:harnessSessionId/*", (req, res) => {
    void forward(req, res);
  });
  router.use((_req, res) => {
    res.status(404).json({ error: "Unknown Assistant route" });
  });

  async function forward(req: Request, res: Response): Promise<void> {
    const path = req.params[0] ?? "";
    const id = req.params.harnessSessionId!;
    const read = req.method === "GET";
    const conversation =
      /^session\/(ses_[A-Za-z0-9_-]+)(\/message|\/prompt_async|\/final-response)?$/.exec(
        path,
      );
    const collection = [
      "experimental/session",
      "session/status",
      "permission",
      "question",
    ].includes(path);
    const prompt =
      !read && req.method === "POST" && conversation?.[2] === "/prompt_async";
    const attach = req.method === "POST" && path === "attach";
    const recover =
      req.method === "POST" && conversation?.[2] === "/final-response";
    const allowed =
      attach ||
      prompt ||
      recover ||
      (read &&
        (path === "event" ||
          collection ||
          (conversation &&
            !["/prompt_async", "/final-response"].includes(
              conversation[2] ?? "",
            ))));
    const queryAllowed = Object.entries(req.query).every(
      ([key, value]) =>
        path === "experimental/session" &&
        ["roots", "archived"].includes(key) &&
        value === "true",
    );
    if (
      !allowed ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
      !queryAllowed ||
      (conversation && !isConversationId(conversation[1])) ||
      (recover &&
        (Object.keys(req.body ?? {}).length !== 1 ||
          !/^msg_[A-Za-z0-9_-]{1,128}$/.test(req.body?.messageId ?? "")))
    ) {
      res.status(400).json({ error: "Unsupported Assistant request" });
      return;
    }
    if (prompt && !validPrompt(req.body)) {
      res.status(400).json({
        error: "Send a text message without model or workspace overrides",
      });
      return;
    }
    const disconnected = new AbortController();
    const cancel = () => disconnected.abort();
    res.once("close", cancel);
    res.setHeader("Cache-Control", "no-store");
    try {
      const hosted = await host.ensure(id);
      const nativeId = await associations.ensure(hosted);
      const signal = AbortSignal.any([hosted.signal, disconnected.signal]);
      signal.throwIfAborted();
      if (conversation && conversation[1] !== nativeId) {
        res.status(403).json({
          error: "Conversation does not belong to this Studio session",
        });
        return;
      }
      if (attach) {
        res.json({ conversationId: nativeId });
        return;
      }
      if (path === "event") {
        await streamOpenCodeEvents(hosted.server, nativeId, res, signal);
        return;
      }
      if (recover) {
        await finalResponse.recover(hosted, nativeId, req.body.messageId);
        if (!res.destroyed) res.status(204).end();
        return;
      }
      if (prompt && finalResponse.isRunning(hosted)) {
        res
          .status(409)
          .json({ error: "Assistant is finishing the previous response" });
        return;
      }
      const nativePath =
        path === "experimental/session" ? `session/${nativeId}` : path;
      const init = {
        method: req.method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        ...(prompt
          ? {
              body: JSON.stringify({
                ...req.body,
                ...openCodeCompletionPrompt(),
              }),
            }
          : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      };
      const upstream = prompt
        ? await finalResponse.send(hosted, nativeId, init)
        : await hosted.server.fetch(`/${nativePath}`, init);
      if (!upstream.ok) {
        await upstream.body?.cancel();
        res.status(upstream.status === 404 ? 404 : 502).json({
          error:
            "Assistant request failed. Refresh the conversation and retry.",
        });
        return;
      }
      if (upstream.status === 204) {
        res.status(204).end();
        return;
      }
      const data = await upstream.json();
      signal.throwIfAborted();
      if (path === "experimental/session") res.json([data]);
      else if (path === "session/status")
        res.json({ [nativeId]: data[nativeId] ?? { type: "idle" } });
      else if (path === "permission" || path === "question")
        res.json(
          data.filter(
            (item: { sessionID?: string }) => item.sessionID === nativeId,
          ),
        );
      else res.json(data);
    } catch (error) {
      if (!res.headersSent && !res.destroyed)
        res.status(error instanceof OpenCodeAccessError ? 403 : 502).json({
          error:
            "Assistant is unavailable. Check Studio sign-in and workspace access, then retry.",
        });
      else res.destroy();
    } finally {
      disconnected.abort();
      res.off("close", cancel);
    }
  }
  return router;
}

function validPrompt(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).every((key) => key === "parts") &&
    Array.isArray(body.parts) &&
    body.parts.length > 0 &&
    body.parts.length <= 32 &&
    body.parts.every(
      (part) =>
        part &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.trim().length > 0 &&
        Object.keys(part).every((key) => ["type", "text"].includes(key)),
    )
  );
}
