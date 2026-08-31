import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const CARRIER_EXPORT = "@sapiom/tools/_internal/agent-runtime-provenance";
const VERSION_HEADER = "x-sapiom-runtime-provenance-version";
const CALLSITE_HEADER = "x-sapiom-runtime-callsite-evidence";
const LINEAGE_HEADER = "x-sapiom-runtime-lineage-receipt";

function fakeAgentServer() {
  const calls = [];
  let execution = 0;
  const fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (init.method === "POST") {
      execution += 1;
      return new Response(
        JSON.stringify({
          status: "enqueued",
          executionId: `exec-${execution}`,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        status: "completed",
        output: { ok: true },
        error: null,
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          [VERSION_HEADER]: "1",
          [LINEAGE_HEADER]: "signed.package-surface",
        },
      },
    );
  };
  return { fetch, calls };
}

function header(call, name) {
  return new Headers(call.init.headers).get(name);
}

async function verifySameFormat(label, tools, carrier) {
  assert.deepEqual(Object.keys(carrier).sort(), [
    "AGENT_RUNTIME_PROVENANCE_VERSION",
    "carryAgentRuntimeProvenance",
  ]);
  const server = fakeAgentServer();
  const client = tools.createClient({ apiKey: "k", fetch: server.fetch });
  const result = await client.agents.run({ definition: `${label}-producer` });
  await client.agents.run(
    carrier.carryAgentRuntimeProvenance(
      { definition: `${label}-consumer`, input: result.output },
      { version: 1, callsite: `callsite.${label}` },
    ),
  );
  const posts = server.calls.filter((call) => call.init.method === "POST");
  assert.equal(header(posts[1], CALLSITE_HEADER), `callsite.${label}`);
  assert.equal(header(posts[1], LINEAGE_HEADER), "signed.package-surface");
  assert.equal(
    JSON.stringify(result).includes("signed.package-surface"),
    false,
  );
  await client.shutdown();
}

const cjsTools = require("@sapiom/tools");
const cjsCarrier = require(CARRIER_EXPORT);
assert.throws(
  () => require("@sapiom/tools/dist/cjs/agents/runtime-callsite-store.js"),
  (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
);
await verifySameFormat("cjs", cjsTools, cjsCarrier);
const sensitiveCjsExports = Object.values(require.cache)
  .filter((loaded) => loaded?.filename.includes("/packages/tools/dist/cjs/"))
  .flatMap((loaded) => Object.keys(loaded?.exports ?? {}))
  .filter((name) =>
    /Lineage|Receipt|retainAgentRuntime|redactAgentRuntime|ProvenanceHeaders/.test(
      name,
    ),
  );
assert.deepEqual(sensitiveCjsExports, []);

const esmTools = await import("@sapiom/tools");
const esmCarrier = await import(CARRIER_EXPORT);
await assert.rejects(
  import("@sapiom/tools/dist/esm/agents/runtime-callsite-store.js"),
  (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
);
assert.deepEqual(Object.keys(esmTools).sort(), Object.keys(cjsTools).sort());
assert.equal(esmTools.createClient, cjsTools.createClient);
assert.equal(
  esmCarrier.carryAgentRuntimeProvenance,
  cjsCarrier.carryAgentRuntimeProvenance,
);
await verifySameFormat("esm", esmTools, esmCarrier);

async function verifyCrossFormatCallsite(label, tools, carrier) {
  const server = fakeAgentServer();
  const client = tools.createClient({ apiKey: "k", fetch: server.fetch });
  await client.agents.launch(
    carrier.carryAgentRuntimeProvenance(
      { definition: `${label}-consumer` },
      { version: 1, callsite: `callsite.${label}` },
    ),
  );
  const post = server.calls.find((call) => call.init.method === "POST");
  assert.equal(header(post, CALLSITE_HEADER), `callsite.${label}`);
  await client.shutdown();
}

async function verifyCrossFormatResult(
  label,
  producerTools,
  consumerTools,
  consumerCarrier,
) {
  const server = fakeAgentServer();
  const producer = producerTools.createClient({
    apiKey: "k",
    fetch: server.fetch,
  });
  const consumer = consumerTools.createClient({
    apiKey: "k",
    fetch: server.fetch,
  });
  for (const target of ["full-result", "output"]) {
    const result = await producer.agents.run({
      definition: `${label}-${target}-producer`,
    });
    await consumer.agents.run(
      consumerCarrier.carryAgentRuntimeProvenance(
        {
          definition: `${label}-${target}-consumer`,
          input: target === "full-result" ? result : result.output,
        },
        { version: 1, callsite: `callsite.${label}.${target}` },
      ),
    );
    const post = server.calls
      .filter((call) => call.init.method === "POST")
      .at(-1);
    assert.equal(header(post, CALLSITE_HEADER), `callsite.${label}.${target}`);
    assert.equal(header(post, LINEAGE_HEADER), "signed.package-surface");
  }
  await Promise.all([producer.shutdown(), consumer.shutdown()]);
}

await verifyCrossFormatCallsite("cjs-carrier-esm-client", esmTools, cjsCarrier);
await verifyCrossFormatCallsite("esm-carrier-cjs-client", cjsTools, esmCarrier);
await verifyCrossFormatResult(
  "cjs-result-esm-client",
  cjsTools,
  esmTools,
  esmCarrier,
);
await verifyCrossFormatResult(
  "esm-result-cjs-client",
  esmTools,
  cjsTools,
  cjsCarrier,
);

console.log(
  "runtime provenance package surfaces: CJS + ESM and four cross-format paths passed",
);
