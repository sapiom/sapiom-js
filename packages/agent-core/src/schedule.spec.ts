/**
 * schedule core fns — assert each builds the right method + path (+ body) against the
 * `/v1/workflows` base. The GatewayClient is faked to record calls.
 */
import type { GatewayClient } from "./client.js";
import {
  cancelSchedule,
  completeScheduleSecretRotation,
  createSchedule,
  getSchedule,
  listSchedules,
  previewCron,
  revokeScheduleSecret,
  rotateScheduleSecret,
} from "./schedule.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function fakeClient(): { client: GatewayClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    get: async (path: string) => {
      calls.push({ method: "GET", path });
      return [];
    },
    post: async (path: string, body?: unknown) => {
      calls.push({ method: "POST", path, body });
      return { id: "trig-1" };
    },
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return { id: "trig-1", status: "disabled" };
    },
  } as unknown as GatewayClient;
  return { client, calls };
}

describe("schedule core fns", () => {
  it("createSchedule POSTs /definitions/:slug/triggers with the body (definition stripped)", async () => {
    const { client, calls } = fakeClient();
    await createSchedule(
      {
        definition: "enrich-lead",
        kind: "schedule_cron",
        cron: "0 9 * * *",
        timezone: "UTC",
      },
      client,
    );
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/definitions/enrich-lead/triggers",
      body: { kind: "schedule_cron", cron: "0 9 * * *", timezone: "UTC" },
    });
  });

  it("createSchedule passes an event trigger through with its eventType", async () => {
    const { client, calls } = fakeClient();
    await createSchedule(
      { definition: "enrich-lead", kind: "event", eventType: "lead.created" },
      client,
    );
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/definitions/enrich-lead/triggers",
      body: { kind: "event", eventType: "lead.created" },
    });
  });

  it("createSchedule sends a webhook trigger with no kind-specific field (the engine mints url + secret)", async () => {
    const { client, calls } = fakeClient();
    await createSchedule(
      { definition: "enrich-lead", kind: "webhook", input: { source: "crm" } },
      client,
    );
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/definitions/enrich-lead/triggers",
      body: { kind: "webhook", input: { source: "crm" } },
    });
  });

  it("listSchedules GETs /definitions/:slug/triggers with a query string", async () => {
    const { client, calls } = fakeClient();
    await listSchedules(
      { definition: "enrich-lead", status: "active", limit: 10 },
      client,
    );
    expect(calls[0]).toEqual({
      method: "GET",
      path: "/definitions/enrich-lead/triggers?status=active&limit=10",
    });
  });

  it("listSchedules omits an empty query", async () => {
    const { client, calls } = fakeClient();
    await listSchedules({ definition: "enrich-lead" }, client);
    expect(calls[0].path).toBe("/definitions/enrich-lead/triggers");
  });

  it("getSchedule GETs /triggers/:id", async () => {
    const { client, calls } = fakeClient();
    await getSchedule("trig-1", client);
    expect(calls[0]).toEqual({ method: "GET", path: "/triggers/trig-1" });
  });

  it("cancelSchedule DELETEs /triggers/:id", async () => {
    const { client, calls } = fakeClient();
    await cancelSchedule("trig-1", client);
    expect(calls[0]).toEqual({
      method: "DELETE",
      path: "/triggers/trig-1",
      body: undefined,
    });
  });

  it("rotateScheduleSecret POSTs /triggers/:id/secret/rotate", async () => {
    const { client, calls } = fakeClient();
    await rotateScheduleSecret("trig-1", client);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/triggers/trig-1/secret/rotate",
      body: undefined,
    });
  });

  it("completeScheduleSecretRotation DELETEs /triggers/:id/secret/previous", async () => {
    const { client, calls } = fakeClient();
    await completeScheduleSecretRotation("trig-1", client);
    expect(calls[0]).toEqual({
      method: "DELETE",
      path: "/triggers/trig-1/secret/previous",
      body: undefined,
    });
  });

  it("revokeScheduleSecret POSTs /triggers/:id/secret/revoke", async () => {
    const { client, calls } = fakeClient();
    await revokeScheduleSecret("trig-1", client);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/triggers/trig-1/secret/revoke",
      body: undefined,
    });
  });

  it("previewCron POSTs /triggers/preview-cron", async () => {
    const { client, calls } = fakeClient();
    await previewCron({ cron: "0 9 * * *", count: 3 }, client);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/triggers/preview-cron",
      body: { cron: "0 9 * * *", count: 3 },
    });
  });
});
