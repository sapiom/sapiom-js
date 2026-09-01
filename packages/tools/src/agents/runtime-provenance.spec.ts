import { createClient } from "../index.js";
import { carryAgentRuntimeProvenance } from "../_internal/agent-runtime-provenance.js";
import * as publicCarrier from "../_internal/agent-runtime-provenance.js";

const AGENT_RUNTIME_PROVENANCE_VERSION_HEADER =
  "x-sapiom-runtime-provenance-version";
const AGENT_RUNTIME_CALLSITE_HEADER = "x-sapiom-runtime-callsite-evidence";
const AGENT_RUNTIME_LINEAGE_HEADER = "x-sapiom-runtime-lineage-receipt";

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
    terminalStatus?: "completed" | "failed" | "cancelled";
  } = {},
): { fetch: typeof globalThis.fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  let nextExecution = 0;
  const fetch = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = String(input);
    // Mirror Fetch's header-value conversion so optional provenance can never
    // make an otherwise valid invocation fail before the request is observed.
    new Headers(init.headers);
    calls.push({ url, init });
    if (init.method === "POST") {
      nextExecution += 1;
      return response(
        { status: "enqueued", executionId: `exec-${nextExecution}` },
        201,
      );
    }
    const terminalStatus = opts.terminalStatus ?? "completed";
    return response(
      terminalStatus === "completed"
        ? { status: terminalStatus, output: { ok: true }, error: null }
        : {
            status: terminalStatus,
            error: { message: `${terminalStatus} privately` },
          },
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
  it("publishes only the minimal build-facing carrier surface", () => {
    expect(Object.keys(publicCarrier).sort()).toEqual([
      "AGENT_RUNTIME_PROVENANCE_VERSION",
      "carryAgentRuntimeProvenance",
    ]);
  });

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
    expect(Reflect.ownKeys(result)).toEqual([
      "executionId",
      "status",
      "output",
      "error",
    ]);
    expect(Reflect.ownKeys(result.output as object)).toEqual(["ok"]);
    for (const descriptor of [
      ...Object.values(Object.getOwnPropertyDescriptors(result)),
      ...Object.values(
        Object.getOwnPropertyDescriptors(result.output as object),
      ),
    ]) {
      expect(descriptor.value).not.toBe("signed.receipt");
    }
    expect(JSON.stringify(result)).not.toContain("signed.receipt");
  });

  it("run forwards a receipt when the exact SDK output is the next input", async () => {
    const server = agentServer({
      receiptVersion: "1",
      receipt: "signed.direct",
    });
    const client = createClient({ apiKey: "k", fetch: server.fetch });
    const result = await client.agents.run({ definition: "producer" });

    await client.agents.run(
      carryAgentRuntimeProvenance(
        {
          definition: "consumer",
          input: result.output as Record<string, unknown>,
        },
        { version: 1, callsite: "callsite.consumer" },
      ),
    );

    const secondLaunch = posts(server.calls)[1]!;
    expect(header(secondLaunch, AGENT_RUNTIME_PROVENANCE_VERSION_HEADER)).toBe(
      "1",
    );
    expect(header(secondLaunch, AGENT_RUNTIME_LINEAGE_HEADER)).toBe(
      "signed.direct",
    );
    expect(JSON.parse(String(secondLaunch.init.body)).input).toEqual(
      result.output,
    );
  });

  it("forwards the exact full SDK result and consumes the shared output alias", async () => {
    const server = agentServer({
      receiptVersion: "1",
      receipt: "signed.full-result",
    });
    const client = createClient({ apiKey: "k", fetch: server.fetch });
    const result = await client.agents.run({ definition: "producer" });

    await client.agents.run(
      carryAgentRuntimeProvenance(
        {
          definition: "full-result-consumer",
          input: result as unknown as Record<string, unknown>,
        },
        { version: 1, callsite: "callsite.full-result" },
      ),
    );
    await client.agents.run(
      carryAgentRuntimeProvenance(
        {
          definition: "output-alias-replay",
          input: result.output as Record<string, unknown>,
        },
        { version: 1, callsite: "callsite.output-replay" },
      ),
    );

    const [, direct, replay] = posts(server.calls);
    expect(header(direct!, AGENT_RUNTIME_LINEAGE_HEADER)).toBe(
      "signed.full-result",
    );
    expect(header(replay!, AGENT_RUNTIME_LINEAGE_HEADER)).toBeUndefined();
  });

  it.each(["failed", "cancelled"] as const)(
    "retains a private receipt on a %s full result",
    async (terminalStatus) => {
      const server = agentServer({
        receiptVersion: "1",
        receipt: `signed.${terminalStatus}`,
        terminalStatus,
      });
      const client = createClient({ apiKey: "k", fetch: server.fetch });
      const result = await client.agents.run({ definition: "producer" });

      await client.agents.run(
        carryAgentRuntimeProvenance(
          {
            definition: "consumer",
            input: result as unknown as Record<string, unknown>,
          },
          { version: 1, callsite: `callsite.${terminalStatus}` },
        ),
      );

      expect(result.status).toBe(terminalStatus);
      expect(
        header(posts(server.calls)[1]!, AGENT_RUNTIME_LINEAGE_HEADER),
      ).toBe(`signed.${terminalStatus}`);
      expect(Reflect.ownKeys(result)).toEqual([
        "executionId",
        "status",
        "output",
        "error",
      ]);
    },
  );

  it("captures input once for both serialization and lineage lookup", async () => {
    const server = agentServer({
      receiptVersion: "1",
      receipt: "signed.single-read",
    });
    const client = createClient({ apiKey: "k", fetch: server.fetch });
    const result = await client.agents.run({ definition: "producer" });
    let reads = 0;
    const spec = carryAgentRuntimeProvenance(
      {
        definition: "consumer",
        get input(): Record<string, unknown> {
          reads += 1;
          return reads === 1
            ? (result.output as Record<string, unknown>)
            : { swapped: true };
        },
      },
      { version: 1, callsite: "callsite.single-read" },
    );

    await client.agents.run(spec);

    const secondLaunch = posts(server.calls)[1]!;
    expect(reads).toBe(1);
    expect(JSON.parse(String(secondLaunch.init.body)).input).toEqual(
      result.output,
    );
    expect(header(secondLaunch, AGENT_RUNTIME_LINEAGE_HEADER)).toBe(
      "signed.single-read",
    );
  });

  it("snapshots validated callsite scalars", async () => {
    const server = agentServer();
    const client = createClient({ apiKey: "k", fetch: server.fetch });
    const provenance = { version: 1 as const, callsite: "callsite.safe" };
    const spec = carryAgentRuntimeProvenance(
      { definition: "consumer" },
      provenance,
    );
    provenance.callsite = "callsite.mutated\r\nprivate";

    await client.agents.launch(spec);

    expect(header(posts(server.calls)[0]!, AGENT_RUNTIME_CALLSITE_HEADER)).toBe(
      "callsite.safe",
    );
  });

  it.each([
    ["NUL/control", `opaque${String.fromCharCode(0)}token`],
    [
      "non-ByteString Unicode/emoji",
      `opaque${String.fromCodePoint(0x1f680)}token`,
    ],
    ["leading whitespace", " opaque-token"],
    ["trailing whitespace", "opaque-token "],
  ])(
    "omits unsupported %s callsite evidence without changing launch behavior",
    async (_label, callsite) => {
      const server = agentServer();
      const client = createClient({ apiKey: "k", fetch: server.fetch });
      const spec = carryAgentRuntimeProvenance(
        { definition: "ordinary", input: { public: true } },
        { version: 1, callsite },
      );

      const handle = await client.agents.launch(spec);
      expect(handle.executionId).toBe("exec-1");
      const launch = posts(server.calls)[0]!;
      expect(
        header(launch, AGENT_RUNTIME_PROVENANCE_VERSION_HEADER),
      ).toBeUndefined();
      expect(header(launch, AGENT_RUNTIME_CALLSITE_HEADER)).toBeUndefined();
      expect(JSON.parse(String(launch.init.body))).toEqual({
        input: { public: true },
      });
    },
  );

  it("requires a build-carried callsite and consumes lineage at an uninstrumented boundary", async () => {
    const server = agentServer({
      receiptVersion: "1",
      receipt: "signed.consume",
    });
    const client = createClient({ apiKey: "k", fetch: server.fetch });
    const result = await client.agents.run({ definition: "producer" });

    await client.agents.run({
      definition: "uninstrumented",
      input: result.output as Record<string, unknown>,
    });
    await client.agents.run(
      carryAgentRuntimeProvenance(
        {
          definition: "replay",
          input: result.output as Record<string, unknown>,
        },
        { version: 1, callsite: "callsite.replay" },
      ),
    );

    const [, uninstrumented, replay] = posts(server.calls);
    expect(
      header(uninstrumented!, AGENT_RUNTIME_LINEAGE_HEADER),
    ).toBeUndefined();
    expect(header(replay!, AGENT_RUNTIME_LINEAGE_HEADER)).toBeUndefined();
  });

  it("consumes one carried callsite and lineage receipt once", async () => {
    const server = agentServer({
      receiptVersion: "1",
      receipt: "signed.once",
    });
    const client = createClient({ apiKey: "k", fetch: server.fetch });
    const result = await client.agents.run({ definition: "producer" });
    const spec = carryAgentRuntimeProvenance(
      {
        definition: "consumer",
        input: result.output as Record<string, unknown>,
      },
      { version: 1, callsite: "callsite.once" },
    );

    await client.agents.run(spec);
    await client.agents.run(spec);

    const [, first, replay] = posts(server.calls);
    expect(header(first!, AGENT_RUNTIME_LINEAGE_HEADER)).toBe("signed.once");
    expect(header(replay!, AGENT_RUNTIME_CALLSITE_HEADER)).toBeUndefined();
    expect(header(replay!, AGENT_RUNTIME_LINEAGE_HEADER)).toBeUndefined();
  });

  it("does not forward an exact reference after a timer boundary", async () => {
    const server = agentServer({
      receiptVersion: "1",
      receipt: "signed.timer",
    });
    const client = createClient({ apiKey: "k", fetch: server.fetch });
    const result = await client.agents.run({ definition: "producer" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await client.agents.run(
      carryAgentRuntimeProvenance(
        {
          definition: "consumer",
          input: result.output as Record<string, unknown>,
        },
        { version: 1, callsite: "callsite.after-timer" },
      ),
    );

    expect(
      header(posts(server.calls)[1]!, AGENT_RUNTIME_LINEAGE_HEADER),
    ).toBeUndefined();
  });

  it.each(["array", "map"] as const)(
    "does not replay an exact reference from %s after an uninstrumented boundary",
    async (container) => {
      const server = agentServer({
        receiptVersion: "1",
        receipt: `signed.${container}`,
      });
      const client = createClient({ apiKey: "k", fetch: server.fetch });
      const result = await client.agents.run({ definition: "producer" });
      let exact: unknown;
      if (container === "array") {
        const stored = [result.output];
        exact = stored[0];
      } else {
        const stored = new Map([["result", result.output]]);
        exact = stored.get("result");
      }

      await client.agents.run({
        definition: "queue-worker-uninstrumented",
        input: exact as Record<string, unknown>,
      });
      await client.agents.run(
        carryAgentRuntimeProvenance(
          {
            definition: "replay",
            input: exact as Record<string, unknown>,
          },
          { version: 1, callsite: `callsite.${container}` },
        ),
      );

      const [, uninstrumented, replay] = posts(server.calls);
      expect(
        header(uninstrumented!, AGENT_RUNTIME_LINEAGE_HEADER),
      ).toBeUndefined();
      expect(header(replay!, AGENT_RUNTIME_LINEAGE_HEADER)).toBeUndefined();
    },
  );

  it.each([
    ["a copied output", (result: object) => ({ ...result })],
    ["a nested output", (result: object) => ({ result })],
    ["a transformed primitive", () => ({ value: "ok" })],
  ])("does not infer lineage through %s", async (_label, toInput) => {
    const server = agentServer({
      receiptVersion: "1",
      receipt: "signed.private",
    });
    const client = createClient({ apiKey: "k", fetch: server.fetch });
    const result = await client.agents.run({ definition: "producer" });

    await client.agents.run(
      carryAgentRuntimeProvenance(
        {
          definition: "consumer",
          input: toInput(result.output as object),
        },
        { version: 1, callsite: `callsite.${_label.replace(/\s/g, "-")}` },
      ),
    );

    const secondLaunch = posts(server.calls)[1]!;
    expect(header(secondLaunch, AGENT_RUNTIME_LINEAGE_HEADER)).toBeUndefined();
    expect(header(secondLaunch, AGENT_RUNTIME_PROVENANCE_VERSION_HEADER)).toBe(
      "1",
    );
  });

  it("ignores an unsupported receipt version", async () => {
    const server = agentServer({
      receiptVersion: "2",
      receipt: "signed.future",
    });
    const client = createClient({ apiKey: "k", fetch: server.fetch });
    const result = await client.agents.run({ definition: "producer" });
    await client.agents.run(
      carryAgentRuntimeProvenance(
        {
          definition: "consumer",
          input: result.output as Record<string, unknown>,
        },
        { version: 1, callsite: "callsite.unsupported" },
      ),
    );

    expect(
      header(posts(server.calls)[1]!, AGENT_RUNTIME_LINEAGE_HEADER),
    ).toBeUndefined();
  });

  it("does not carry provenance through delayed dispatch", async () => {
    const server = agentServer({
      receiptVersion: "1",
      receipt: "signed.queue",
    });
    const client = createClient({ apiKey: "k", fetch: server.fetch });
    const result = await client.agents.run({ definition: "producer" });
    const scheduled = carryAgentRuntimeProvenance(
      {
        definition: "consumer",
        input: result.output as Record<string, unknown>,
        at: "2026-09-01T00:00:00.000Z",
      },
      { version: 1, callsite: "callsite.delayed" },
    );

    await client.agents.launch(scheduled);
    await client.agents.launch(
      carryAgentRuntimeProvenance(
        {
          definition: "consumer-replay",
          input: result.output as Record<string, unknown>,
        },
        { version: 1, callsite: "callsite.after-delayed" },
      ),
    );

    const delayedLaunch = posts(server.calls)[1]!;
    const replay = posts(server.calls)[2]!;
    expect(
      header(delayedLaunch, AGENT_RUNTIME_CALLSITE_HEADER),
    ).toBeUndefined();
    expect(header(delayedLaunch, AGENT_RUNTIME_LINEAGE_HEADER)).toBeUndefined();
    expect(
      header(delayedLaunch, AGENT_RUNTIME_PROVENANCE_VERSION_HEADER),
    ).toBeUndefined();
    expect(header(replay, AGENT_RUNTIME_LINEAGE_HEADER)).toBeUndefined();
  });

  it("redacts reflected request provenance from invocation errors", async () => {
    const calls: CapturedCall[] = [];
    const receipt = "signed.invocation-private";
    let postCount = 0;
    const fetch = (async (
      input: string | URL | Request,
      init: RequestInit = {},
    ) => {
      calls.push({ url: String(input), init });
      if (init.method !== "POST") {
        return response(
          { status: "completed", output: { ok: true }, error: null },
          200,
          {
            [AGENT_RUNTIME_PROVENANCE_VERSION_HEADER]: "1",
            [AGENT_RUNTIME_LINEAGE_HEADER]: receipt,
          },
        );
      }
      postCount += 1;
      if (postCount === 1) {
        return response(
          { status: "enqueued", executionId: "exec-producer" },
          201,
        );
      }
      const headers = init.headers as Record<string, string>;
      return response(
        {
          message: `rejected ${headers[AGENT_RUNTIME_CALLSITE_HEADER] ?? ""} ${
            headers[AGENT_RUNTIME_LINEAGE_HEADER] ?? ""
          }`,
        },
        400,
      );
    }) as typeof globalThis.fetch;
    const client = createClient({ apiKey: "k", fetch });
    const result = await client.agents.run({ definition: "producer" });
    const spec = carryAgentRuntimeProvenance(
      {
        definition: "child",
        input: result.output as Record<string, unknown>,
      },
      { version: 1, callsite: "callsite.must-stay-private" },
    );

    let error: unknown;
    try {
      await client.agents.launch(spec);
    } catch (value) {
      error = value;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("rejected");
    expect((error as Error).message).not.toContain(
      "callsite.must-stay-private",
    );
    expect((error as Error).message).not.toContain(receipt);
    expect(String(posts(calls)[1]!.init.body)).not.toContain(
      "callsite.must-stay-private",
    );
    expect(String(posts(calls)[1]!.init.body)).not.toContain(receipt);
  });

  it("rethrows an uninstrumented typed transport error untouched", async () => {
    const cause = Object.assign(new Error("connect refused"), {
      code: "ECONNREFUSED",
    });
    const failure = new TypeError("fetch failed") as TypeError & {
      cause: Error;
    };
    Object.defineProperty(failure, "cause", {
      configurable: true,
      value: cause,
      writable: true,
    });
    const originalStack = failure.stack;
    const fetch = (async () => {
      throw failure;
    }) as typeof globalThis.fetch;
    const client = createClient({ apiKey: "k", fetch });

    let error: unknown;
    try {
      await client.agents.launch({ definition: "uninstrumented" });
    } catch (value) {
      error = value;
    }

    expect(error).toBe(failure);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error & { cause: Error }).cause).toBe(cause);
    expect((error as Error).stack).toBe(originalStack);
    expect(
      ((error as Error & { cause: Error }).cause as Error & { code: string })
        .code,
    ).toBe("ECONNREFUSED");
  });

  it("redacts nested ordinary diagnostics without mutating the original error graph", async () => {
    const callsite = "callsite.nested-private";
    interface NestedDiagnostics {
      request: {
        headers: Record<string, string>;
        lazyDiagnostic?: string;
      };
      response: { status: number; retryable: boolean };
      observedAt: Date;
    }
    let accessorReads = 0;
    const observedAt = new Date("2026-09-01T00:00:00.000Z");
    const diagnostics: NestedDiagnostics = {
      request: {
        headers: {
          [AGENT_RUNTIME_CALLSITE_HEADER]: callsite,
          "x-request-id": "request-public",
        },
      },
      response: { status: 502, retryable: true },
      observedAt,
    };
    Object.defineProperty(diagnostics.request, "lazyDiagnostic", {
      configurable: true,
      enumerable: false,
      get() {
        accessorReads += 1;
        return "lazy-public";
      },
    });
    class DiagnosticTransportError extends TypeError {
      readonly code = "EAGENT";
      constructor(readonly diagnostics: NestedDiagnostics) {
        super("fetch failed with diagnostics");
      }
    }
    const failure = new DiagnosticTransportError(diagnostics);
    Object.defineProperty(failure, "stack", {
      configurable: true,
      enumerable: false,
      value:
        "DiagnosticTransportError: fetch failed with diagnostics\n    at preserved-frame.ts:1:1",
      writable: true,
    });
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      failure,
      "diagnostics",
    );
    const fetch = (async () => {
      throw failure;
    }) as typeof globalThis.fetch;
    const client = createClient({ apiKey: "k", fetch });

    let error: unknown;
    try {
      await client.agents.launch(
        carryAgentRuntimeProvenance(
          { definition: "instrumented-nested" },
          { version: 1, callsite },
        ),
      );
    } catch (value) {
      error = value;
    }

    expect(error).not.toBe(failure);
    expect(error).toBeInstanceOf(DiagnosticTransportError);
    expect((error as DiagnosticTransportError).code).toBe("EAGENT");
    expect((error as DiagnosticTransportError).message).toBe(failure.message);
    expect((error as DiagnosticTransportError).stack).toBe(failure.stack);
    expect(
      (error as DiagnosticTransportError).diagnostics.request.headers[
        AGENT_RUNTIME_CALLSITE_HEADER
      ],
    ).toBe("[REDACTED runtime provenance]");
    expect(
      (error as DiagnosticTransportError).diagnostics.request.headers[
        "x-request-id"
      ],
    ).toBe("request-public");
    expect((error as DiagnosticTransportError).diagnostics.response).toEqual({
      status: 502,
      retryable: true,
    });
    expect((error as DiagnosticTransportError).diagnostics.observedAt).toBe(
      observedAt,
    );
    expect(observedAt.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(accessorReads).toBe(0);
    expect(
      Object.getOwnPropertyDescriptor(
        (error as DiagnosticTransportError).diagnostics.request,
        "lazyDiagnostic",
      )?.get,
    ).toBe(
      Object.getOwnPropertyDescriptor(
        failure.diagnostics.request,
        "lazyDiagnostic",
      )?.get,
    );
    expect(Object.getOwnPropertyDescriptor(error, "diagnostics")).toEqual(
      expect.objectContaining({
        configurable: originalDescriptor?.configurable,
        enumerable: originalDescriptor?.enumerable,
        writable: originalDescriptor?.writable,
      }),
    );

    expect(failure.diagnostics).toBe(diagnostics);
    expect(
      failure.diagnostics.request.headers[AGENT_RUNTIME_CALLSITE_HEADER],
    ).toBe(callsite);
    expect(failure.code).toBe("EAGENT");
  });

  it("preserves exact identity when supplied provenance does not occur in nested diagnostics", async () => {
    const diagnostics = {
      request: { headers: { "x-request-id": "request-public" } },
    };
    const failure = Object.assign(new TypeError("fetch failed"), {
      code: "EAGENT",
      diagnostics,
    });
    const fetch = (async () => {
      throw failure;
    }) as typeof globalThis.fetch;
    const client = createClient({ apiKey: "k", fetch });

    let error: unknown;
    try {
      await client.agents.launch(
        carryAgentRuntimeProvenance(
          { definition: "instrumented-no-match" },
          { version: 1, callsite: "callsite.not-reflected" },
        ),
      );
    } catch (value) {
      error = value;
    }

    expect(error).toBe(failure);
    expect((error as typeof failure).diagnostics).toBe(diagnostics);
  });

  it("redacts arrays and preserves cycles and shared ordinary diagnostics", async () => {
    const callsite = "callsite.cyclic-private";
    const shared: Record<string, unknown> = {
      privateValue: callsite,
      publicValue: "shared-public",
    };
    const diagnostics: Record<string, unknown> = {
      entries: [shared, shared],
      shared,
    };
    diagnostics.self = diagnostics;
    const failure = Object.assign(new TypeError("fetch failed"), {
      code: "EAGENT",
      diagnostics,
    });
    const fetch = (async () => {
      throw failure;
    }) as typeof globalThis.fetch;
    const client = createClient({ apiKey: "k", fetch });

    let error: unknown;
    try {
      await client.agents.launch(
        carryAgentRuntimeProvenance(
          { definition: "instrumented-cyclic" },
          { version: 1, callsite },
        ),
      );
    } catch (value) {
      error = value;
    }

    const sanitized = (error as typeof failure).diagnostics;
    const sanitizedEntries = sanitized.entries as Record<string, unknown>[];
    expect(error).not.toBe(failure);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as typeof failure).code).toBe("EAGENT");
    expect(sanitized).not.toBe(diagnostics);
    expect(sanitized.self).toBe(sanitized);
    expect(sanitizedEntries[0]).toBe(sanitizedEntries[1]);
    expect(sanitizedEntries[0]).toBe(sanitized.shared);
    expect(sanitizedEntries[0]!.privateValue).toBe(
      "[REDACTED runtime provenance]",
    );
    expect(sanitizedEntries[0]!.publicValue).toBe("shared-public");

    expect(diagnostics.self).toBe(diagnostics);
    expect((diagnostics.entries as object[])[0]).toBe(shared);
    expect(shared.privateValue).toBe(callsite);
  });

  it("preserves typed errors, causes, diagnostics, and stack frames while redacting", async () => {
    const callsite = "callsite.typed-private";
    class AgentTransportError extends TypeError {
      readonly diagnostic = "request transport failed";
      readonly code = "EAGENT";
    }
    const cause = Object.assign(new Error(`connect failed for ${callsite}`), {
      code: "ECONNREFUSED",
    });
    const failure = new AgentTransportError(
      `fetch failed for ${callsite}`,
    ) as AgentTransportError & { cause: Error };
    Object.defineProperty(failure, "stack", {
      configurable: true,
      value:
        `AgentTransportError: fetch failed for ${callsite}\n` +
        "    at runtime-provenance.spec.ts:1:1",
      writable: true,
    });
    Object.defineProperty(cause, "stack", {
      configurable: true,
      value:
        `Error: connect failed for ${callsite}\n` +
        "    at runtime-provenance.spec.ts:2:1",
      writable: true,
    });
    Object.defineProperty(failure, "cause", {
      configurable: true,
      value: cause,
      writable: true,
    });
    const fetch = (async () => {
      throw failure;
    }) as typeof globalThis.fetch;
    const client = createClient({ apiKey: "k", fetch });

    let error: unknown;
    try {
      await client.agents.launch(
        carryAgentRuntimeProvenance(
          { definition: "instrumented" },
          { version: 1, callsite },
        ),
      );
    } catch (value) {
      error = value;
    }

    expect(error).not.toBe(failure);
    expect(error).toBeInstanceOf(AgentTransportError);
    expect(Object.getPrototypeOf(error)).toBe(AgentTransportError.prototype);
    expect((error as AgentTransportError).name).toBe(failure.name);
    expect((error as AgentTransportError).code).toBe("EAGENT");
    expect((error as AgentTransportError).diagnostic).toBe(
      "request transport failed",
    );
    expect((error as AgentTransportError).message).toContain("fetch failed");
    expect((error as AgentTransportError).message).not.toContain(callsite);
    expect((error as AgentTransportError).stack).toContain(
      "runtime-provenance.spec.ts",
    );
    expect((error as AgentTransportError).stack).not.toContain(callsite);
    const redactedCause = (error as AgentTransportError & { cause: Error })
      .cause as Error & { code: string };
    expect(redactedCause).not.toBe(cause);
    expect(redactedCause).toBeInstanceOf(Error);
    expect(redactedCause.code).toBe("ECONNREFUSED");
    expect(redactedCause.message).toContain("connect failed");
    expect(redactedCause.message).not.toContain(callsite);
    expect(redactedCause.stack).not.toContain(callsite);
  });

  it("redacts reflected callsite and response receipt from status errors", async () => {
    const receipt = "signed.status-private";
    const callsite = "callsite.status-private";
    const fetch = (async (
      _input: string | URL | Request,
      init: RequestInit = {},
    ) => {
      if (init.method === "POST") {
        return response(
          { status: "enqueued", executionId: "exec-status" },
          201,
        );
      }
      return response({ message: `reflected ${callsite} ${receipt}` }, 500, {
        [AGENT_RUNTIME_PROVENANCE_VERSION_HEADER]: "1",
        [AGENT_RUNTIME_LINEAGE_HEADER]: receipt,
      });
    }) as typeof globalThis.fetch;
    const client = createClient({ apiKey: "k", fetch });
    const handle = await client.agents.launch(
      carryAgentRuntimeProvenance(
        { definition: "child" },
        { version: 1, callsite },
      ),
    );

    let error: unknown;
    try {
      await handle.status();
    } catch (value) {
      error = value;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("reflected");
    expect((error as Error).message).not.toContain(callsite);
    expect((error as Error).message).not.toContain(receipt);
  });

  it("redacts known provenance from status parsing errors", async () => {
    const receipt = "signed.parse-private";
    const callsite = "callsite.parse-private";
    const fetch = (async (
      _input: string | URL | Request,
      init: RequestInit = {},
    ) => {
      if (init.method === "POST") {
        return response({ status: "enqueued", executionId: "exec-parse" }, 201);
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          [AGENT_RUNTIME_PROVENANCE_VERSION_HEADER]: "1",
          [AGENT_RUNTIME_LINEAGE_HEADER]: receipt,
        }),
        json: async () => {
          throw new Error(`invalid response ${callsite} ${receipt}`);
        },
      } as unknown as Response;
    }) as typeof globalThis.fetch;
    const client = createClient({ apiKey: "k", fetch });
    const handle = await client.agents.launch(
      carryAgentRuntimeProvenance(
        { definition: "child" },
        { version: 1, callsite },
      ),
    );

    let error: unknown;
    try {
      await handle.status();
    } catch (value) {
      error = value;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invalid response");
    expect((error as Error).message).not.toContain(callsite);
    expect((error as Error).message).not.toContain(receipt);
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
