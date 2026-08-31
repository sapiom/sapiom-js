import { createClient } from "../index.js";
import {
  AGENT_RUNTIME_CALLSITE_HEADER,
  AGENT_RUNTIME_LINEAGE_HEADER,
  AGENT_RUNTIME_PROVENANCE_VERSION_HEADER,
  carryAgentRuntimeProvenance,
} from "../_internal/agent-runtime-provenance.js";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function response(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => value,
    text: async () => JSON.stringify(value),
  } as Response;
}

function agentServer(
  opts: {
    receiptVersion?: string;
    receipt?: string;
  } = {},
): { fetch: typeof globalThis.fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  let nextExecution = 0;
  const fetch = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = String(input);
    calls.push({ url, init });
    if (init.method === "POST") {
      nextExecution += 1;
      return response(
        { status: "enqueued", executionId: `exec-${nextExecution}` },
        201,
      );
    }
    return response(
      { status: "completed", output: { ok: true }, error: null },
      200,
      {
        ...(opts.receiptVersion
          ? {
              [AGENT_RUNTIME_PROVENANCE_VERSION_HEADER]: opts.receiptVersion,
            }
          : {}),
        ...(opts.receipt
          ? { [AGENT_RUNTIME_LINEAGE_HEADER]: opts.receipt }
          : {}),
      },
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function header(call: CapturedCall, name: string): string | undefined {
  const headers = call.init.headers as Record<string, string>;
  return headers?.[name];
}

function posts(calls: CapturedCall[]): CapturedCall[] {
  return calls.filter((call) => call.init.method === "POST");
}

describe("agents runtime provenance v1", () => {
  it("launch carries opaque callsite evidence out of band and wait retains a private receipt", async () => {
    const server = agentServer({
      receiptVersion: "1",
      receipt: "signed.receipt",
    });
    const client = createClient({ apiKey: "k", fetch: server.fetch });
    const spec = carryAgentRuntimeProvenance(
      { definition: "child", input: { public: true } },
      { version: 1, callsite: "callsite.opaque" },
    );

    const handle = await client.agents.launch(spec);
    const result = await handle.wait({ pollMs: 1 });
    const launch = posts(server.calls)[0]!;

    expect(header(launch, AGENT_RUNTIME_PROVENANCE_VERSION_HEADER)).toBe("1");
    expect(header(launch, AGENT_RUNTIME_CALLSITE_HEADER)).toBe(
      "callsite.opaque",
    );
    expect(JSON.parse(String(launch.init.body))).toEqual({
      input: { public: true },
    });
    expect(result).toEqual({
      executionId: "exec-1",
      status: "completed",
      output: { ok: true },
      error: null,
    });
    expect(Object.keys(result)).toEqual([
      "executionId",
      "status",
      "output",
      "error",
    ]);
    expect(JSON.stringify(result)).not.toContain("signed.receipt");
  });

  it("run forwards a receipt only when the exact SDK result is the next input", async () => {
    const server = agentServer({
      receiptVersion: "1",
      receipt: "signed.direct",
    });
    const client = createClient({ apiKey: "k", fetch: server.fetch });
    const result = await client.agents.run({ definition: "producer" });

    await client.agents.run({
      definition: "consumer",
      input: result as unknown as Record<string, unknown>,
    });

    const secondLaunch = posts(server.calls)[1]!;
    expect(header(secondLaunch, AGENT_RUNTIME_PROVENANCE_VERSION_HEADER)).toBe(
      "1",
    );
    expect(header(secondLaunch, AGENT_RUNTIME_LINEAGE_HEADER)).toBe(
      "signed.direct",
    );
    expect(JSON.parse(String(secondLaunch.init.body)).input).toEqual(result);
  });

  it.each([
    ["a copied result", (result: object) => ({ ...result })],
    ["a nested result", (result: object) => ({ result })],
    ["a transformed primitive", () => ({ value: "ok" })],
  ])("does not infer lineage through %s", async (_label, toInput) => {
    const server = agentServer({
      receiptVersion: "1",
      receipt: "signed.private",
    });
    const client = createClient({ apiKey: "k", fetch: server.fetch });
    const result = await client.agents.run({ definition: "producer" });

    await client.agents.run({
      definition: "consumer",
      input: toInput(result),
    });

    const secondLaunch = posts(server.calls)[1]!;
    expect(header(secondLaunch, AGENT_RUNTIME_LINEAGE_HEADER)).toBeUndefined();
    expect(
      header(secondLaunch, AGENT_RUNTIME_PROVENANCE_VERSION_HEADER),
    ).toBeUndefined();
  });

  it("ignores an unsupported receipt version", async () => {
    const server = agentServer({
      receiptVersion: "2",
      receipt: "signed.future",
    });
    const client = createClient({ apiKey: "k", fetch: server.fetch });
    const result = await client.agents.run({ definition: "producer" });
    await client.agents.run({
      definition: "consumer",
      input: result as unknown as Record<string, unknown>,
    });

    expect(
      header(posts(server.calls)[1]!, AGENT_RUNTIME_LINEAGE_HEADER),
    ).toBeUndefined();
  });

  it("preserves legacy request and result behavior when provenance is absent", async () => {
    const server = agentServer();
    const client = createClient({ apiKey: "k", fetch: server.fetch });
    const result = await client.agents.run({
      definition: "legacy",
      input: { value: 1 },
      idempotencyKey: "same",
    });
    const launch = posts(server.calls)[0]!;

    expect(header(launch, AGENT_RUNTIME_CALLSITE_HEADER)).toBeUndefined();
    expect(header(launch, AGENT_RUNTIME_LINEAGE_HEADER)).toBeUndefined();
    expect(
      header(launch, AGENT_RUNTIME_PROVENANCE_VERSION_HEADER),
    ).toBeUndefined();
    expect(JSON.parse(String(launch.init.body))).toEqual({
      input: { value: 1 },
      idempotencyKey: "same",
    });
    expect(result.output).toEqual({ ok: true });
  });
});
