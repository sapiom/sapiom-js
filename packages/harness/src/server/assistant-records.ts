import express, { type Router } from "express";
import { createBootTokenMiddleware } from "./auth.js";
import type { AssistantAssociation } from "../core/assistant-session-store.js";
import type { AssistantRecordStore } from "../core/assistant-record-store.js";
import { OpenCodeAccessError } from "../core/opencode-host.js";

export function createAssistantRecordsRouter(options: {
  bootToken: string;
  authorize: (id: string) => Promise<AssistantAssociation | null>;
  store: Pick<AssistantRecordStore, "read">;
}): Router {
  const router = express.Router();
  router.use(createBootTokenMiddleware(options.bootToken));
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
