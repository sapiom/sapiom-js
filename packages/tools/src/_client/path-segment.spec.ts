import { Transport } from "./index.js";
import { encodeSegment, isUnsafeSegment } from "./path-segment.js";
import { dns } from "../domains/index.js";
import { getInbox } from "../email/index.js";
import * as vault from "../vault/index.js";
import { getDownloadUrl } from "../file-storage/index.js";
import * as database from "../database/index.js";
import * as memory from "../memory/index.js";
import * as schedules from "../schedules/index.js";
import { getSession } from "../llm/index.js";
import { Sandbox } from "../sandboxes/index.js";
import { Repository } from "../repositories/index.js";
import { closeSession } from "../browser-automation/index.js";
import { mcp } from "../connectors/mcp/index.js";

describe("encodeSegment", () => {
  it.each(["", ".", ".."])("rejects %j", (value) => {
    expect(isUnsafeSegment(value)).toBe(true);
    expect(() => encodeSegment(value, "recordId")).toThrow(TypeError);
    expect(() => encodeSegment(value, "recordId")).toThrow(/recordId/);
  });

  it.each([
    ["a.b", "a.b"],
    ["user@x.com", "user%40x.com"],
    ["...", "..."],
    ["a/b", "a%2Fb"],
  ])("encodes %j as before", (value, encoded) => {
    expect(isUnsafeSegment(value)).toBe(false);
    expect(encodeSegment(value, "id")).toBe(encodeURIComponent(value));
    expect(encodeSegment(value, "id")).toBe(encoded);
  });
});

describe("caller ids used as path segments", () => {
  let fetchMock: jest.Mock;
  let transport: Transport;

  beforeEach(() => {
    fetchMock = jest.fn(() =>
      Promise.resolve(
        new Response("{}", {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    transport = new Transport({
      apiKey: "test-key",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
  });

  it.each(["..", ""])(
    "domains.dns.delete refuses recordId %j before any request",
    async (recordId) => {
      await expect(
        dns.delete({ domainName: "d.com", recordId }, transport),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("refuses an empty schedule id before any request", async () => {
    await expect(schedules.get("", transport)).rejects.toThrow(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an empty llm session id before any request", async () => {
    await expect(getSession("", transport)).rejects.toThrow(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const calls: Array<[string, (t: Transport) => Promise<unknown>]> = [
    [
      "domains.dns.delete",
      (t) => dns.delete({ domainName: "d.com", recordId: ".." }, t),
    ],
    ["email.getInbox", (t) => getInbox("..", t)],
    ["vault.get", (t) => vault.get("ref", "..", t)],
    ["fileStorage.getDownloadUrl", (t) => getDownloadUrl("..", t)],
    ["database.get", (t) => database.get("..", t)],
    ["memory.drop", (t) => memory.drop("..", t)],
    ["schedules.get", (t) => schedules.get("..", t)],
    ["llm.getSession", (t) => getSession("..", t)],
    ["Sandbox.destroy", (t) => Sandbox.attach("..", {}, t).destroy()],
    ["Repository.get", (t) => Repository.get("..", t)],
    ["browserAutomation.closeSession", (t) => closeSession("..", t)],
    ["mcp.listTools", (t) => mcp("..", t).listTools()],
  ];

  it.each(calls)("%s refuses '..' before any request", async (_label, call) => {
    await expect(call(transport)).rejects.toThrow(/\.\./);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still sends an address-form inbox id as one encoded segment", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "user@x.com" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await getInbox("user@x.com", transport).catch(() => undefined);

    expect(String(fetchMock.mock.calls[0]![0])).toMatch(
      /\/v1\/inboxes\/user%40x\.com$/,
    );
  });
});
