import { afterEach, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { createAssistantRecordsRouter } from "./assistant-records.js";
import { OpenCodeAccessError } from "../core/opencode-host.js";
import type { AssistantAssociation } from "../core/assistant-session-store.js";

let server: Server, origin: string;
const binding: AssistantAssociation = {
  version: 1,
  harnessSessionId: "studio-a",
  contextAuthorityScope: "a".repeat(64),
  conversationId: "ses_a",
  cwd: "/workspace",
  nativeScope: "b".repeat(64),
  createdAt: 1,
};
const authorize = vi.fn(),
  read = vi.fn();
const list = vi.fn();
const history = {
  list,
  listWithWorkspace: undefined as undefined | ReturnType<typeof vi.fn>,
};
const request = (token = "boot") =>
  fetch(`${origin}/sessions/studio-a/assistant/record`, {
    headers: { "X-Harness-Token": token },
  });
beforeEach(async () => {
  authorize.mockReset().mockResolvedValue(binding);
  read.mockReset().mockResolvedValue({ reconstructed: true });
  list
    .mockReset()
    .mockResolvedValue([{ kind: "assistant", harnessSessionId: "studio-a" }]);
  history.listWithWorkspace = undefined;
  const app = express();
  app.use(
    createAssistantRecordsRouter({
      bootToken: "boot",
      authorize,
      store: { read },
      history,
    }),
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it("requires boot authorization and reads only the exact current binding without native IO", async () => {
  expect((await request("wrong")).status).toBe(401);
  expect(read).not.toHaveBeenCalled();
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(read).toHaveBeenCalledWith({
    harnessSessionId: "studio-a",
    contextAuthorityScope: "a".repeat(64),
    conversationId: "ses_a",
    cwd: "/workspace",
  });
  expect(authorize).toHaveBeenCalledTimes(2);
});

it("does not return content when authority changes during a read", async () => {
  authorize.mockResolvedValueOnce(binding).mockResolvedValueOnce({
    ...binding,
    contextAuthorityScope: "c".repeat(64),
  });
  expect((await request()).status).toBe(403);
  authorize.mockRejectedValueOnce(new OpenCodeAccessError("expired"));
  expect((await request()).status).toBe(403);
});

it("distinguishes missing history from failed reads without exposing diagnostics", async () => {
  read.mockResolvedValueOnce(null);
  expect((await request()).status).toBe(404);
  read.mockRejectedValueOnce(new Error("private diagnostic /path/to/file"));
  const response = await request();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private diagnostic");
});

it("gates metadata listing and rejects ambiguous workspace queries", async () => {
  const url = `${origin}/sessions/assistant-history?cwd=%2Fworkspace`;
  expect((await fetch(url)).status).toBe(401);
  expect(list).not.toHaveBeenCalled();
  const headers = { "X-Harness-Token": "boot" };
  const response = await fetch(url, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    entries: [{ kind: "assistant", harnessSessionId: "studio-a" }],
  });
  expect(list).toHaveBeenCalledWith("/workspace");
  expect((await fetch(`${url}&cwd=%2Fother`, { headers })).status).toBe(400);
  list.mockRejectedValueOnce(new OpenCodeAccessError("private"));
  expect((await fetch(url, { headers })).status).toBe(403);
  list.mockRejectedValueOnce(new Error("private"));
  const failed = await fetch(url, { headers });
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("private");
});

it("returns the verified query and canonical pair from the history authority", async () => {
  const result = {
    entries: [],
    workspace: { cwd: "/alias", canonicalCwd: "/workspace" },
  };
  history.listWithWorkspace = vi.fn().mockResolvedValue(result);
  const response = await fetch(
    `${origin}/sessions/assistant-history?cwd=%2Falias`,
    { headers: { "X-Harness-Token": "boot" } },
  );
  expect(await response.json()).toEqual(result);
  expect(history.listWithWorkspace).toHaveBeenCalledWith("/alias");
  expect(list).not.toHaveBeenCalled();
});
