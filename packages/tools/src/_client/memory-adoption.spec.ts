import { createClient } from "../client.js";
import { append, MemoryHttpError } from "../memory/index.js";
import { ExecutionIndeterminateError } from "../executions/errors.js";
import { capabilityCall } from "./capability-call.js";
import { Transport } from "./index.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const receipt = {
  version: 1,
  id: "11111111-1111-4111-8111-111111111111",
  capabilityId: "memory.append",
  status: "queued",
  createdAt: "2026-09-23T00:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z",
};
const appendInput = {
  content: "fact",
  namespace: "project",
  metadata: { active: false, count: 0 },
  occurredAt: "2026-09-23T00:00:00Z",
};
const recallInput = {
  query: "question",
  namespace: "project",
  topK: 50,
  strategy: "hybrid" as const,
  weight: { temporal: { halfLifeDays: 3 } },
  filter: { active: { in: [false] } },
};
const cases = [
  {
    id: "memory.append",
    input: appendInput,
    path: "/v1/memory/append",
    method: "POST",
    result: { ...appendInput, id: "m1", createdAt: "2026-09-23T00:00:00Z" },
    call: (c: ReturnType<typeof createClient>) => c.memory.append(appendInput),
  },
  {
    id: "memory.recall",
    input: recallInput,
    path: "/v1/memory/recall",
    method: "POST",
    result: { results: [], query: "question", topK: 50, count: 0 },
    call: (c: ReturnType<typeof createClient>) => c.memory.recall(recallInput),
  },
  {
    id: "memory.forget",
    input: { ids: ["", "m1"], namespace: "project" },
    path: "/v1/memory",
    method: "DELETE",
    result: {},
    call: (c: ReturnType<typeof createClient>) =>
      c.memory.forget({ ids: ["", "m1"], namespace: "project" }),
  },
  {
    id: "memory.drop",
    input: { namespace: "project" },
    path: "/v1/memory/namespaces/project",
    method: "DELETE",
    result: {},
    call: (c: ReturnType<typeof createClient>) => c.memory.drop("project"),
  },
];

describe("memory adoption", () => {
  it.each(cases)(
    "preserves $id DTOs and void results in both modes",
    async (fixture) => {
      const results = [];
      for (const capabilityDelivery of ["legacy", "executions"] as const) {
        const calls: { url: string; init: RequestInit }[] = [];
        const saved = { ...receipt, capabilityId: fixture.id };
        const client = createClient({
          apiKey: "fixture",
          coreBaseUrl: "https://core.test",
          capabilityDelivery,
          fetch: async (url, init) => {
            calls.push({ url: String(url), init: init! });
            if (String(url).endsWith("/executions")) return json(saved);
            if (String(url).includes("/capability-executions/"))
              return json({
                ...saved,
                status: "succeeded",
                result: fixture.result,
              });
            return fixture.method === "DELETE"
              ? new Response(null, { status: 204 })
              : json(fixture.result);
          },
        }).withAttribution({ agentName: "memory-agent" });
        results.push(await fixture.call(client));
        const first = calls[0];
        expect(calls).toHaveLength(capabilityDelivery === "executions" ? 2 : 1);
        expect(first.url).toContain(
          capabilityDelivery === "executions"
            ? `/v1/capabilities/${fixture.id}/executions`
            : fixture.path,
        );
        expect(first.init.method).toBe(
          capabilityDelivery === "executions" ? "POST" : fixture.method,
        );
        if (capabilityDelivery === "executions" || fixture.id !== "memory.drop")
          expect(JSON.parse(String(first.init.body))).toEqual(fixture.input);
        expect(
          new Headers(first.init.headers).get(
            capabilityDelivery === "executions"
              ? "x-api-key"
              : "x-sapiom-api-key",
          ),
        ).toBe("fixture");
        expect(new Headers(first.init.headers).get("x-sapiom-agent-name")).toBe(
          "memory-agent",
        );
      }
      expect(results[1]).toEqual(results[0]);
      if (fixture.method === "DELETE") expect(results[1]).toBeUndefined();
    },
  );

  it("keeps the service override on the legacy branch without treating it as a Core origin", async () => {
    const urls: string[] = [];
    for (const capabilityDelivery of ["legacy", "executions"] as const) {
      const transport = new Transport({
        apiKey: "fixture",
        coreBaseUrl: "https://core.test",
        capabilityDelivery,
        fetch: async (url, init) => {
          urls.push(String(url));
          return json(
            String(url).endsWith("/executions")
              ? receipt
              : init?.method === "GET"
                ? { ...receipt, status: "succeeded", result: {} }
                : {},
          );
        },
      });
      await append(appendInput, transport, "https://custom-memory.test");
    }
    expect(urls).toEqual([
      "https://custom-memory.test/v1/memory/append",
      "https://core.test/v1/capabilities/memory.append/executions",
      `https://core.test/v1/capability-executions/${receipt.id}`,
    ]);
  });

  it.each(["admission", "failed", "indeterminate"])(
    "never invokes the legacy callback after %s",
    async (kind) => {
      const legacyCall = jest.fn(async () => ({}));
      const transport = new Transport({
        apiKey: "fixture",
        coreBaseUrl: "https://core.test",
        capabilityDelivery: "executions",
        fetch: async (_, init) => {
          if (kind === "admission")
            return json({ code: "admission_disabled" }, 503);
          return json(
            init?.method === "POST"
              ? receipt
              : {
                  ...receipt,
                  status: kind,
                  error: { code: `execution_${kind}`, message: "Safe failure" },
                },
          );
        },
      });
      await expect(
        capabilityCall(
          "memory.append",
          {},
          {
            transport,
            legacyCall,
            errorPrefix: "Memory failed",
            makeError: (m, s, b) => new MemoryHttpError(m, s, b),
          },
        ),
      ).rejects.toBeInstanceOf(
        kind === "indeterminate"
          ? ExecutionIndeterminateError
          : MemoryHttpError,
      );
      expect(legacyCall).not.toHaveBeenCalled();
    },
  );
});
