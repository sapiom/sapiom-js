import express, { type Router } from "express";
import { createBootTokenMiddleware } from "./auth.js";
import type { AssistantAssociation } from "../core/assistant-session-store.js";
import type { AssistantRecordStore } from "../core/assistant-record-store.js";
import { OpenCodeAccessError } from "../core/opencode-host.js";
import type { AssistantHistory } from "../core/assistant-history.js";

export function createAssistantRecordsRouter(options: {
  bootToken: string;
  authorize: (id: string) => Promise<AssistantAssociation | null>;
  store: Pick<AssistantRecordStore, "read">;
  history?: Pick<AssistantHistory, "list">;
}): Router {
  const router = express.Router();
  router.use(createBootTokenMiddleware(options.bootToken));
  if (options.history)
    router.get("/sessions/assistant-history", (req, res) => {
      void (async () => {
        res.setHeader("Cache-Control", "no-store");
        if (
          Object.keys(req.query).length !== 1 ||
          typeof req.query.cwd !== "string"
        ) {
          res.status(400).json({ error: "Select a workspace" });
          return;
        }
        try {
          res.json({ entries: await options.history!.list(req.query.cwd) });
        } catch (error) {
          res
            .status(error instanceof OpenCodeAccessError ? 403 : 503)
            .json({ error: "Assistant history unavailable" });
        }
      })();
    });
  router.get("/sessions/:id/assistant/record", (req, res) => {
    void (async () => {
      res.setHeader("Cache-Control", "no-store");
      try {
        const id = req.params.id;
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
          res.sendStatus(400);
          return;
        }
        const binding = await options.authorize(id);
        if (!binding) {
          res.status(404).json({ error: "Assistant record missing" });
          return;
        }
        const { harnessSessionId, contextAuthorityScope, conversationId, cwd } =
          binding;
        const record = await options.store.read({
          harnessSessionId,
          contextAuthorityScope,
          conversationId,
          cwd,
        });
        if (
          JSON.stringify(await options.authorize(id)) !==
          JSON.stringify(binding)
        )
          throw new OpenCodeAccessError("Assistant binding changed");
        if (!record) {
          res.status(404).json({ error: "Assistant record missing" });
          return;
        }
        res.json({ record });
      } catch (error) {
        res
          .status(error instanceof OpenCodeAccessError ? 403 : 503)
          .json({ error: "Assistant record unavailable" });
      }
    })();
  });
  return router;
}
