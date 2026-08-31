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
await verifySameFormat("esm", esmTools, esmCarrier);

// Mixed CJS/ESM loading intentionally has isolated closure state. Sharing via a
// discoverable global would make the receipt store consumer-accessible. Pin the
// documented boundary: mixed-format carrier/client pairs do not forward.
const mixedServer = fakeAgentServer();
const mixedClient = esmTools.createClient({
  apiKey: "k",
  fetch: mixedServer.fetch,
});
await mixedClient.agents.launch(
  cjsCarrier.carryAgentRuntimeProvenance(
    { definition: "mixed-consumer" },
    { version: 1, callsite: "callsite.mixed" },
  ),
);
const mixedPost = mixedServer.calls.find((call) => call.init.method === "POST");
assert.equal(header(mixedPost, CALLSITE_HEADER), null);
await mixedClient.shutdown();

console.log(
  "runtime provenance package surfaces: CJS + ESM passed; mixed format isolated",
);
