import express, { type Response, type Router } from "express";
import { z } from "zod";
import type { AssistantHistory } from "../core/assistant-history.js";
import type { AssistantNativeHistory } from "../core/assistant-native-history.js";
import type { AssistantAttachment } from "../core/assistant-lifecycle.js";
import type {
  AssistantContinueRequest,
  PreparedAssistantContinuation,
} from "../core/assistant-continuation.js";
import {
  AssistantContinuationConflictError,
  type AssistantContinuationReceipt,
} from "../core/assistant-continuation-store.js";
import { AssistantContinuationUnconfirmedError } from "../core/assistant-continuation-native.js";
import { OpenCodeTransportError } from "../core/opencode-host.js";
import type { HarnessSession } from "../shared/types.js";
import type { AssistantContinuationView } from "../shared/assistant-continuation.js";
import { openCodeTransportFailure } from "../shared/opencode-errors.js";
import { createBootTokenMiddleware } from "./auth.js";
import {
  assistantHistoryMatches,
  sameAssistantWorkspace,
} from "../shared/assistant-history.js";

const inspectionRequest = z
  .object({ expectedRevision: z.number().int().nonnegative().safe() })
  .strict();
const resumeRequest = inspectionRequest
  .extend({ operationId: z.string().uuid() })
  .strict();
const continueRequest = resumeRequest
  .extend({ expectedRecordRevision: z.number().int().positive().safe() })
  .strict();
const changed = () =>
  new OpenCodeTransportError(openCodeTransportFailure("lifecycle_changed"));
const sessionView = (session: HarnessSession): HarnessSession => ({
  ...session,
  agentSessionId: session.agentSessionId ?? null,
  boundWorkflowPath: session.boundWorkflowPath ?? null,
});

/** No private binding, accepted reference, system, or frozen source input crosses this boundary. */
export function projectAssistantContinuation(
  receipt: AssistantContinuationReceipt,
): AssistantContinuationView {
  if (receipt.phase !== "prepared" || !receipt.childBinding)
    throw new AssistantContinuationUnconfirmedError();
  return {
    operationId: receipt.operationId,
    sourceSessionId: receipt.sourceBinding.harnessSessionId,
    sourceRecordRevision: receipt.sourceRecordRevision,
    capturedAt: receipt.brief.capturedAt,
    retainedTurns: receipt.brief.retainedTurns,
    omittedTurns: receipt.brief.omittedTurns,
    seed: {
      conversationId: receipt.childBinding.conversationId,
      messageId: receipt.seedMessageId,
      partId: receipt.seedPartId,
      text: receipt.brief.text,
      sha256: receipt.brief.sha256,
    },
  };
}

function failure(res: Response, error: unknown) {
  const value =
    error instanceof OpenCodeTransportError
      ? error.failure
      : error instanceof AssistantContinuationConflictError
        ? openCodeTransportFailure("lifecycle_changed")
        : error instanceof AssistantContinuationUnconfirmedError
          ? openCodeTransportFailure("continuation_unconfirmed")
          : openCodeTransportFailure("transport_unavailable");
  const status = [
    "access_denied",
    "access_expired",
    "authentication_required",
  ].includes(value.code)
    ? 403
    : [
          "lifecycle_changed",
          "session_ended",
          "cleanup_unconfirmed",
          "continuation_unconfirmed",
        ].includes(value.code)
      ? 409
      : 503;
  res.status(status).json({ error: value });
}

export function createAssistantLifecycleRouter(options: {
  bootToken: string;
  history: Pick<AssistantHistory, "entry">;
  native: Pick<AssistantNativeHistory, "inspect">;
  getSession: (id: string) => HarnessSession | undefined;
  resume: (
    id: string,
    expectedRevision: number,
    operationId: string,
  ) => Promise<AssistantAttachment>;
  continue?: (
    id: string,
    request: AssistantContinueRequest,
  ) => Promise<PreparedAssistantContinuation>;
}): Router {
  const router = express.Router();
  router.use(
    createBootTokenMiddleware(options.bootToken),
    express.json({ limit: "8kb" }),
  );
  router.post("/sessions/:id/assistant/:action", (req, res) => {
    void (async () => {
      res.setHeader("Cache-Control", "no-store");
      const { id, action } = req.params;
      const schema =
        action === "inspect"
          ? inspectionRequest
          : action === "resume"
            ? resumeRequest
            : action === "continue"
              ? continueRequest
              : null;
      if (!schema) {
        res.sendStatus(404);
        return;
      }
      const parsed = schema.safeParse(req.body);
      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
        Object.keys(req.query).length ||
        !parsed.success
      ) {
        res.sendStatus(400);
        return;
      }
      try {
        const entry = await options.history.entry(id);
        if (!entry) {
          res.sendStatus(404);
          return;
        }
        if (action === "inspect") {
          if (entry.lifecycle.revision !== parsed.data.expectedRevision)
            throw changed();
          const checked = await options.native.inspect(
            id,
            parsed.data.expectedRevision,
          );
          const current = await options.history.entry(id);
          if (
            !current ||
            current.lifecycle.revision !== parsed.data.expectedRevision ||
            !sameAssistantWorkspace(current, entry) ||
            current.continuationScope !== entry.continuationScope
          )
            throw changed();
          res.json({
            entry: {
              ...current,
              nativeResume: checked.nativeResume,
              ...(checked.resumeFailure
                ? { resumeFailure: checked.resumeFailure }
                : {}),
            },
          });
        } else if (action === "resume") {
          const request = resumeRequest.parse(parsed.data);
          const attachment = await options.resume(
            id,
            request.expectedRevision,
            request.operationId,
          );
          const current = await options.history.entry(id);
          const session = options.getSession(id);
          if (
            !session ||
            !current ||
            !sameAssistantWorkspace(current, entry) ||
            !assistantHistoryMatches(current, session.id, session.cwd) ||
            current.continuationScope !== entry.continuationScope ||
            current.lifecycle.revision !== attachment.lifecycle.revision ||
            current.lifecycle.lifecycle !== "open"
          )
            throw changed();
          res.json({
            session: sessionView(session),
            attachment,
            ...(current.workspace ? { workspace: current.workspace } : {}),
          });
        } else {
          if (!options.continue)
            throw new OpenCodeTransportError(
              openCodeTransportFailure("context_unavailable"),
            );
          const prepared = await options.continue(
            id,
            continueRequest.parse(parsed.data),
          );
          res.json({
            session: sessionView(prepared.session),
            attachment: prepared.attachment,
            continuation: projectAssistantContinuation(prepared.receipt),
          });
        }
      } catch (error) {
        failure(res, error);
      }
    })();
  });
  return router;
}
