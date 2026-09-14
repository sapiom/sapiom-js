import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { AssistantNativeHistory } from "./assistant-native-history.js";
import type { HostedOpenCode } from "./opencode-host.js";
import type { AssistantAssociation } from "./assistant-session-store.js";

const binding: AssistantAssociation = {
  version: 1, harnessSessionId: "studio-a", cwd: "/same/folder", conversationId: "ses_saved",
  nativeScope: "a".repeat(64), contextAuthorityScope: "b".repeat(64), createdAt: 1,
};
const message = (system: string | undefined = "retained-system") => ({
  info: { id: "msg_original", sessionID: binding.conversationId, role: "user", system, time: { created: 1 } },
  parts: [{ id: "part_saved", messageID: "msg_original", sessionID: binding.conversationId, type: "text", text: "task" }],
});
function fixture(history: unknown = [message()]) {
  const lifetime = new AbortController();
  const fetch = vi.fn(async (path: string, _init?: RequestInit) => Response.json(
    path.endsWith("/message") ? history : { id: binding.conversationId, directory: binding.cwd },
  ));
  const hosted: HostedOpenCode = {
    harnessSessionId: binding.harnessSessionId, cwd: binding.cwd, contextAuthorityScope: binding.contextAuthorityScope,
    stateRoot: join("/state/opencode", binding.nativeScope), model: { providerID: "sapiom", modelID: "test" },
    signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted,
    server: { pid: 1, exited: new Promise(() => {}), close: vi.fn(), fetch, fetchJson: vi.fn() },
  };
  const authorize = vi.fn<() => Promise<AssistantAssociation | null>>(async () => ({ ...binding }));
  const preflight = vi.fn(async () => ({ system: "validated-retained-system" }));
  const calls: unknown[] = [];
  let afterRead = () => {};
  const service = new AssistantNativeHistory({
    authorize, preflight, timeoutMs: 100,
    lifecycle: { inspect: async <T>(id: string, revision: number, read: (hosted: HostedOpenCode, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> => {
      calls.push([id, revision]);
      const result = await read(hosted, signal ?? lifetime.signal);
      afterRead();
      return result;
    } },
  });
  return { service, hosted, fetch, authorize, preflight, calls, afterRead: (run: () => void) => { afterRead = run; } };
}
afterEach(() => vi.useRealTimers());

it("queries only the authorized saved native ID and preflights its original system without dispatch", async () => {
  const f = fixture();
  expect(await f.service.inspect("studio-a", 7)).toMatchObject({
    nativeHistory: "available", nativeResume: "available", savedSystem: "retained-system", sourceMessageId: "msg_original",
  });
  expect(f.calls).toEqual([["studio-a", 7]]);
  expect(f.fetch.mock.calls.map(([path]) => path)).toEqual(["/session/ses_saved", "/session/ses_saved/message"]);
  expect(f.fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  expect(f.preflight).toHaveBeenCalledExactlyOnceWith(f.hosted, "ses_saved", "retained-system", expect.any(AbortSignal));
});

it.each([404, 500])("distinguishes native HTTP %s from successful execution readiness", async (status) => {
  const f = fixture();
  f.fetch.mockResolvedValueOnce(new Response(null, { status }));
  expect(await f.service.inspect("studio-a", 0)).toMatchObject({
    nativeHistory: status === 404 ? "missing" : "unavailable", nativeResume: status === 404 ? "missing" : "unavailable",
    resumeFailure: { code: status === 404 ? "native_history_missing" : "transport_unavailable" },
  });
  expect(f.preflight).not.toHaveBeenCalled();
});

it("allows an empty native conversation without inventing accepted context", async () => {
  const f = fixture([]);
  expect(await f.service.inspect("studio-a", 0)).toEqual({ nativeHistory: "available", nativeResume: "available" });
  expect(f.preflight).not.toHaveBeenCalled();
});

it("reports known missing retained context separately from missing native history", async () => {
  const f = fixture();
  f.preflight.mockRejectedValue(new Error("private source path"));
  const result = await f.service.inspect("studio-a", 0);
  expect(result).toMatchObject({ nativeHistory: "available", nativeResume: "unavailable", resumeFailure: { code: "context_unavailable" } });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(result.savedSystem).toBeUndefined();
});

it.each(["missing-system", "only-assistant"])("rejects nonempty unsupported history: %s", async (kind) => {
  const row = message();
  if (kind === "missing-system") delete (row.info as { system?: string }).system;
  else row.info.role = "assistant";
  const f = fixture([row]);
  expect(await f.service.inspect("studio-a", 0)).toMatchObject({ nativeHistory: "available", nativeResume: "unavailable", resumeFailure: { code: "context_unavailable" } });
  expect(f.preflight).not.toHaveBeenCalled();
});

it("selects the original user system behind later synthetic compaction messages", async () => {
  const compact = message();
  compact.info.id = "msg_compaction";
  compact.info.time.created = 2;
  compact.parts[0]!.type = "compaction";
  compact.parts[0]!.messageID = compact.info.id;
  const f = fixture([compact, message()]);
  expect(await f.service.inspect("studio-a", 0)).toMatchObject({ sourceMessageId: "msg_original", nativeResume: "available" });
});

it.each(["harnessSessionId", "cwd", "contextAuthorityScope", "nativeScope"] as const)("denies a mismatched authorized %s before querying", async (field) => {
  const f = fixture();
  f.authorize.mockResolvedValue({ ...binding, [field]: field === "cwd" ? "/different" : "f".repeat(64) });
  await expect(f.service.inspect("studio-a", 0)).rejects.toMatchObject({ failure: { code: "access_denied" } });
  expect(f.fetch).not.toHaveBeenCalled();
});

it("requires a saved association and revalidates account/binding after cleanup", async () => {
  const f = fixture();
  f.authorize.mockResolvedValueOnce(null);
  await expect(f.service.inspect("studio-a", 0)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  f.afterRead(() => f.authorize.mockResolvedValue({ ...binding, conversationId: "ses_other" }));
  await expect(f.service.inspect("studio-a", 0)).rejects.toMatchObject({ failure: { code: "access_denied" } });
});

it.each(["wrong-session", "wrong-message", "malformed", "oversized"])("fails closed for %s native payloads", async (kind) => {
  const row = message();
  if (kind === "wrong-message") row.info.sessionID = "ses_other";
  const f = fixture([row]);
  if (kind === "wrong-session") f.fetch.mockResolvedValueOnce(Response.json({ id: "ses_other" }));
  if (kind === "malformed") f.fetch.mockResolvedValueOnce(new Response("{broken"));
  if (kind === "oversized") f.fetch.mockResolvedValueOnce(new Response(new Uint8Array(65537)));
  expect(await f.service.inspect("studio-a", 0)).toMatchObject({ nativeResume: "unavailable", resumeFailure: { code: "transport_unavailable" } });
  expect(f.preflight).not.toHaveBeenCalled();
});

it.each(["authorization", "query", "preflight"])("bounds a hung %s provider", async (stage) => {
  vi.useFakeTimers();
  const f = fixture();
  if (stage === "authorization") f.authorize.mockImplementationOnce(() => new Promise(() => {}));
  if (stage === "query") f.fetch.mockImplementationOnce(() => new Promise(() => {}));
  if (stage === "preflight") f.preflight.mockImplementationOnce(() => new Promise(() => {}));
  const result = f.service.inspect("studio-a", 0);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject({ nativeResume: "unavailable" });
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels a body stream that never finishes within the overall read deadline", async () => {
  vi.useFakeTimers();
  const f = fixture(), cancel = vi.fn();
  f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel })));
  const result = f.service.inspect("studio-a", 0);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject({ nativeResume: "unavailable", resumeFailure: { code: "transport_unavailable" } });
  expect(cancel).toHaveBeenCalledOnce();
  expect(f.preflight).not.toHaveBeenCalled();
});
