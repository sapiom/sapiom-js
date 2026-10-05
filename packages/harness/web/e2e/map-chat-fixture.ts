import type { Page } from "@playwright/test";
import express, { type Response } from "express";
import type { Server } from "node:http";

import { openCodeCompletionPrompt } from "../../src/shared/opencode-completion";

/**
 * A map chat's OpenCode host, without a model (design-map-chat.md §1).
 *
 * The mock build has no server, so the map chat's `/opencode/map:<projectId>/…`
 * requests are routed here, the way `opencode-chat.spec.ts` serves a session's
 * Assistant. It speaks the same HTTP + SSE surface P2's proxy forwards, plus
 * the map chat's own two routes (`reset`, `abort`), and answers by script:
 *
 *  - "Add a step …" or "Start a session …": a `handoff` tool call, then a
 *    final answer the model marks FAILED (P2's real check: the model calls
 *    the turn failed because the work was not done in the chat);
 *  - "slow …": a reply that keeps streaming until Stop;
 *  - anything else: "Answer: <the question>".
 */
type Turn = { info: Record<string, any>; parts: Array<Record<string, any>> };
interface Conversation {
  id: string;
  turns: Turn[];
  streams: Set<Response>;
  prompts: string[];
  busy: boolean;
}

export interface FakeMapChat {
  /** Every prompt any map chat received, as sent (context line included). */
  prompts: (projectId?: string) => string[];
  /** Host keys the browser asked for, e.g. `map:<projectId>`. */
  hosts: () => string[];
  resets: () => number;
  aborts: () => number;
  close: () => Promise<void>;
}

const HANDOFF_PROMPT = (question: string) =>
  `Work in this project.\nTask: ${question.replace(/^Context:[^\n]*\n\n/, "")}.\nRead the agent's steps first, make the change, run check and run_local, and report what changed.`;

export async function serveMapChat(page: Page): Promise<FakeMapChat> {
  const conversations = new Map<string, Conversation>();
  const current = new Map<string, string>();
  const hosts = new Set<string>();
  let resets = 0;
  let aborts = 0;
  let generation = 0;
  // OpenCode's ids sort in creation order; the adapter orders by them.
  let sequence = 0;
  const nextId = (prefix: string) =>
    `${prefix}_${String(++sequence).padStart(8, "0")}`;

  const conversationFor = (host: string): Conversation => {
    let id = current.get(host);
    if (!id) {
      id = `ses_map_${++generation}`;
      current.set(host, id);
    }
    let c = conversations.get(id);
    if (!c) {
      c = { id, turns: [], streams: new Set(), prompts: [], busy: false };
      conversations.set(id, c);
    }
    return c;
  };
  const emit = (c: Conversation, type: string, properties: object) => {
    if (type === "session.status")
      c.busy = (properties as { status: { type: string } }).status.type !== "idle";
    for (const stream of c.streams)
      stream.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
  };
  const push = (c: Conversation, turn: Turn) => {
    c.turns.push(turn);
    emit(c, "message.updated", { info: turn.info });
    for (const part of turn.parts) emit(c, "message.part.updated", { part });
  };
  const finish = (c: Conversation, turn: Turn, text: string) => {
    turn.parts[0]!.text = text;
    turn.info.time.completed = Date.now();
    turn.info.finish = "stop";
    emit(c, "message.part.updated", { part: turn.parts[0] });
    emit(c, "message.updated", { info: turn.info });
    emit(c, "session.status", { sessionID: c.id, status: { type: "idle" } });
  };

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
    });
    if (req.method === "OPTIONS") {
      res.end();
      return;
    }
    next();
  });
  app.all("/opencode/:host/*", (req, res) => {
    const host = req.params.host;
    hosts.add(host);
    const path = req.params[0];
    if (path === "reset") {
      resets++;
      current.delete(host);
      res.json({ conversationId: conversationFor(host).id });
      return;
    }
    const c = conversationFor(host);
    const id = c.id;
    const session = { id, title: "Map chat", time: { created: 1, updated: 1 } };
    if (path === "attach") return void res.json({ conversationId: id });
    if (path === "experimental/session") return void res.json([session]);
    if (path === `session/${id}`) return void res.json(session);
    if (path === `session/${id}/message`) return void res.json(c.turns);
    if (path === "permission" || path === "question") return void res.json([]);
    if (path === "session/status")
      return void res.json({ [id]: { type: c.busy ? "busy" : "idle" } });
    if (path === "event") {
      res.type("text/event-stream").flushHeaders();
      c.streams.add(res);
      res.write('data: {"type":"server.connected","properties":{}}\n\n');
      res.write(
        `data: ${JSON.stringify({ type: "session.status", properties: { sessionID: id, status: { type: c.busy ? "busy" : "idle" } } })}\n\n`,
      );
      res.once("close", () => c.streams.delete(res));
      return;
    }
    if (path === `session/${id}/abort`) {
      // What OpenCode does on abort: the answer ends with MessageAbortedError,
      // a session.error says so, and the session goes idle.
      aborts++;
      const turn = c.turns.at(-1);
      if (turn && turn.info.role === "assistant" && !turn.info.time.completed) {
        const error = { name: "MessageAbortedError", data: { message: "Aborted" } };
        turn.info.error = error;
        turn.info.time.completed = Date.now();
        emit(c, "message.updated", { info: turn.info });
        emit(c, "session.error", { sessionID: id, error });
      }
      emit(c, "session.status", { sessionID: id, status: { type: "idle" } });
      res.json(true);
      return;
    }
    if (path === `session/${id}/prompt_async`) {
      const text = String(req.body.parts[0].text);
      c.prompts.push(text);
      const n = c.turns.length;
      const userId = nextId("msg");
      const callId = nextId("msg");
      const assistantId = nextId("msg");
      const { system } = openCodeCompletionPrompt({ mapChat: true });
      const token = /StudioAssistantResult\/v2:([a-f0-9-]{36})/.exec(system)![1];
      const user: Turn = {
        info: { id: userId, sessionID: id, role: "user", agent: "build", system, time: { created: Date.now() } },
        parts: [{ id: `prt_${userId}`, sessionID: id, messageID: userId, type: "text", text }],
      };
      res.status(204).end();
      emit(c, "session.status", { sessionID: id, status: { type: "busy" } });
      push(c, user);
      const question = text.replace(/^Context:[^\n]*\n\n/, "");
      if (/^(Add a step|Start a session)/.test(question)) {
        const title = question.startsWith("Start a session")
          ? "Session for this project"
          : question.slice(0, 60);
        const call: Turn = {
          info: { id: callId, sessionID: id, role: "assistant", parentID: userId, agent: "build", finish: "tool-calls", time: { created: Date.now(), completed: Date.now() }, modelID: "smart", providerID: "sapiom" },
          parts: [
            {
              id: `prt_${assistantId}_tool`, sessionID: id, messageID: callId, type: "tool", callID: `call_${n}`, tool: "handoff",
              state: { status: "completed", input: { title, prompt: HANDOFF_PROMPT(text) }, output: "Hand-off card shown.", title, metadata: {}, time: { start: 1, end: 2 } },
            },
          ],
        };
        push(c, call);
        const answer: Turn = {
          info: { id: assistantId, sessionID: id, role: "assistant", parentID: userId, agent: "build", time: { created: Date.now() }, modelID: "smart", providerID: "sapiom" },
          parts: [{ id: `prt_${assistantId}`, sessionID: id, messageID: assistantId, type: "text", text: "" }],
        };
        push(c, answer);
        finish(c, answer, `<!-- studio-result:${token}:failed -->\nThis needs a session, so I offered one you can start.`);
        return;
      }
      const answer: Turn = {
        info: { id: assistantId, sessionID: id, role: "assistant", parentID: userId, agent: "build", time: { created: Date.now() }, modelID: "smart", providerID: "sapiom" },
        parts: [{ id: `prt_${assistantId}`, sessionID: id, messageID: assistantId, type: "text", text: "" }],
      };
      push(c, answer);
      if (question.startsWith("slow")) {
        answer.parts[0]!.text = "Thinking it through";
        emit(c, "message.part.updated", { part: answer.parts[0] });
        return;
      }
      finish(c, answer, `<!-- studio-result:${token}:finished -->\nAnswer: ${question}`);
      return;
    }
    res.status(404).end();
  });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  await page.route("**/api/assistant/access", (route) =>
    route.fulfill({ status: 200, json: { enabled: true, authorityRevision: "map-chat" } }),
  );
  await page.route("**/opencode/**", (route) => {
    const url = new URL(route.request().url());
    return route.continue({ url: `${origin}${url.pathname}${url.search}` });
  });

  return {
    prompts: (projectId) =>
      [...current.entries()]
        .filter(([host]) => !projectId || host === `map:${projectId}`)
        .flatMap(([, id]) => conversations.get(id)?.prompts ?? []),
    hosts: () => [...hosts],
    resets: () => resets,
    aborts: () => aborts,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of conversations.values())
          for (const stream of c.streams) stream.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
