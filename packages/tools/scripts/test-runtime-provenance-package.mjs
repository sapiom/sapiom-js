import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CARRIER_EXPORT = "@sapiom/tools/_internal/agent-runtime-provenance";
const VERSION_HEADER = "x-sapiom-runtime-provenance-version";
const CALLSITE_HEADER = "x-sapiom-runtime-callsite-evidence";
const LINEAGE_HEADER = "x-sapiom-runtime-lineage-receipt";

function verifyIsolatedFormat(label, source, inputType) {
  const result = spawnSync(
    process.execPath,
    [...(inputType ? ["--input-type", inputType] : []), "--eval", source],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, SAPIOM_API_KEY: "isolated-format-key" },
    },
  );
  assert.equal(
    result.status,
    0,
    `${label} isolated probe failed\n${result.stdout}\n${result.stderr}`,
  );
}

const isolatedServerSource = `
let execution = 0;
globalThis.fetch = async (_input, init = {}) => {
  new Headers(init.headers);
  if (init.method === "POST") {
    execution += 1;
    return new Response(JSON.stringify({ status: "enqueued", executionId: "isolated-" + execution }), { status: 201, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ status: "completed", output: { ok: true }, error: null }), { status: 200, headers: { "content-type": "application/json" } });
};`;

verifyIsolatedFormat(
  "ESM native transport",
  `
import { createRequire } from "node:module";
${isolatedServerSource}
const require = createRequire(import.meta.url);
const tools = await import("@sapiom/tools");
const handle = await tools.agents.launch({ definition: "esm-native-launch" });
if ((await handle.wait({ pollMs: 1 })).status !== "completed") process.exit(2);
if ((await tools.agents.run({ definition: "esm-native-run" })).status !== "completed") process.exit(3);
if (Object.keys(require.cache).some((path) => path.endsWith("/dist/cjs/_client/index.js"))) process.exit(4);
`,
  "module",
);

verifyIsolatedFormat(
  "CJS native transport",
  `
${isolatedServerSource}
const tools = require("@sapiom/tools");
(async () => {
  const handle = await tools.agents.launch({ definition: "cjs-native-launch" });
  if ((await handle.wait({ pollMs: 1 })).status !== "completed") process.exit(2);
  if ((await tools.agents.run({ definition: "cjs-native-run" })).status !== "completed") process.exit(3);
  if (Object.keys(require.cache).some((path) => path.includes("/dist/esm/"))) process.exit(4);
})().catch((error) => { console.error(error); process.exit(5); });
`,
);

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

async function captureLaunchError(client, spec) {
  try {
    await client.agents.launch(spec);
  } catch (error) {
    return error;
  }
  assert.fail("expected agent launch to throw");
}

class NativeStackTransportError extends TypeError {
  constructor(message, cause, diagnostics) {
    super(message, { cause });
    this.name = "NativeStackTransportError";
    this.code = "EAGENT";
    this.diagnostics = diagnostics;
  }
}

function nativeStackFixture(callsite, diagnostics) {
  const cause = new Error(`native cause reflected ${callsite}`);
  cause.code = "ECONNREFUSED";
  return new NativeStackTransportError(
    `native transport reflected ${callsite}`,
    cause,
    diagnostics,
  );
}

async function verifyNativeErrorStackRedaction(tools, carrier) {
  const callsite = "callsite.package-native-stack";
  let nestedGetterReads = 0;
  const diagnostics = {
    request: {
      headers: {
        [CALLSITE_HEADER]: callsite,
        "x-request-id": "request-public",
      },
    },
    response: { status: 502, retryable: true },
  };
  Object.defineProperty(diagnostics.request, "lazy", {
    configurable: true,
    enumerable: false,
    get() {
      nestedGetterReads += 1;
      return callsite;
    },
  });
  const failure = nativeStackFixture(callsite, diagnostics);
  const failureStackDescriptor = Object.getOwnPropertyDescriptor(
    failure,
    "stack",
  );
  assert.ok(failureStackDescriptor);
  const failureStackIsDataDescriptor = "value" in failureStackDescriptor;
  assert.equal(typeof failure.stack, "string");
  assert.match(failure.stack, /nativeStackFixture/);
  assert.match(failure.stack, new RegExp(callsite));
  const client = tools.createClient({
    apiKey: "k",
    fetch: async () => {
      throw failure;
    },
  });
  const caught = await captureLaunchError(
    client,
    carrier.carryAgentRuntimeProvenance(
      { definition: "package-native-stack" },
      { version: 1, callsite },
    ),
  );

  assert.notEqual(caught, failure);
  assert.ok(caught instanceof NativeStackTransportError);
  assert.equal(
    Object.getPrototypeOf(caught),
    NativeStackTransportError.prototype,
  );
  assert.equal(caught.code, "EAGENT");
  assert.equal(caught.diagnostics.response.status, 502);
  assert.equal(caught.diagnostics.response.retryable, true);
  assert.equal(
    caught.diagnostics.request.headers["x-request-id"],
    "request-public",
  );
  assert.equal(
    caught.diagnostics.request.headers[CALLSITE_HEADER],
    "[REDACTED runtime provenance]",
  );
  assert.equal(typeof caught.stack, "string");
  assert.match(caught.stack, /nativeStackFixture/);
  assert.equal(caught.stack.includes(callsite), false);
  const caughtStackDescriptor = Object.getOwnPropertyDescriptor(
    caught,
    "stack",
  );
  assert.ok(caughtStackDescriptor);
  assert.equal("value" in caughtStackDescriptor, failureStackIsDataDescriptor);
  assert.equal(
    caughtStackDescriptor.configurable,
    failureStackDescriptor.configurable,
  );
  assert.equal(
    caughtStackDescriptor.enumerable,
    failureStackDescriptor.enumerable,
  );
  if (failureStackIsDataDescriptor) {
    assert.equal(
      caughtStackDescriptor.writable,
      failureStackDescriptor.writable,
    );
    assert.equal(caughtStackDescriptor.value, caught.stack);
  } else {
    assert.equal(caughtStackDescriptor.get, failureStackDescriptor.get);
    assert.equal(caughtStackDescriptor.set, failureStackDescriptor.set);
  }
  assert.equal(caught.message.includes(callsite), false);
  assert.equal(caught.cause.message.includes(callsite), false);
  assert.equal(typeof caught.cause.stack, "string");
  assert.match(caught.cause.stack, /nativeStackFixture/);
  assert.equal(caught.cause.stack.includes(callsite), false);
  assert.equal(caught.cause.code, "ECONNREFUSED");
  assert.equal(nestedGetterReads, 0);
  assert.equal(failure.message.includes(callsite), true);
  assert.equal(failure.stack.includes(callsite), true);
  assert.equal(failure.cause.message.includes(callsite), true);
  assert.equal(failure.cause.stack.includes(callsite), true);
  assert.equal(failure.diagnostics.request.headers[CALLSITE_HEADER], callsite);
  await client.shutdown();

  let customStackReads = 0;
  let customDiagnosticReads = 0;
  const customDiagnostics = { reflected: callsite };
  Object.defineProperty(customDiagnostics, "lazy", {
    configurable: true,
    enumerable: false,
    get() {
      customDiagnosticReads += 1;
      return callsite;
    },
  });
  const customFailure = new NativeStackTransportError(
    "custom stack transport",
    new Error("public cause"),
    customDiagnostics,
  );
  const customStackGetter = () => {
    customStackReads += 1;
    return `custom stack ${callsite}`;
  };
  Object.defineProperty(customFailure, "stack", {
    configurable: true,
    enumerable: false,
    get: customStackGetter,
  });
  const customClient = tools.createClient({
    apiKey: "k",
    fetch: async () => {
      throw customFailure;
    },
  });
  const customCaught = await captureLaunchError(
    customClient,
    carrier.carryAgentRuntimeProvenance(
      { definition: "package-custom-stack" },
      { version: 1, callsite },
    ),
  );
  assert.notEqual(customCaught, customFailure);
  assert.equal(customStackReads, 0);
  assert.equal(customDiagnosticReads, 0);
  const customStackDescriptor = Object.getOwnPropertyDescriptor(
    customCaught,
    "stack",
  );
  assert.equal(customStackDescriptor.value, "[REDACTED runtime provenance]");
  assert.equal("get" in customStackDescriptor, false);
  assert.equal("set" in customStackDescriptor, false);
  const customLazyDescriptor = Object.getOwnPropertyDescriptor(
    customCaught.diagnostics,
    "lazy",
  );
  assert.equal(customLazyDescriptor.value, "[REDACTED runtime provenance]");
  assert.equal("get" in customLazyDescriptor, false);
  assert.equal("set" in customLazyDescriptor, false);
  assert.equal(
    customCaught.diagnostics.reflected,
    "[REDACTED runtime provenance]",
  );
  await customClient.shutdown();

  const noMatchFailure = nativeStackFixture("public-value", {
    request: { headers: { "x-request-id": "request-public" } },
  });
  const noMatchClient = tools.createClient({
    apiKey: "k",
    fetch: async () => {
      throw noMatchFailure;
    },
  });
  const noMatchCaught = await captureLaunchError(
    noMatchClient,
    carrier.carryAgentRuntimeProvenance(
      { definition: "package-no-match" },
      { version: 1, callsite: "callsite.not-reflected" },
    ),
  );
  assert.equal(noMatchCaught, noMatchFailure);
  await noMatchClient.shutdown();

  const noPrivateFailure = new TypeError("uninstrumented transport");
  const noPrivateClient = tools.createClient({
    apiKey: "k",
    fetch: async () => {
      throw noPrivateFailure;
    },
  });
  const noPrivateCaught = await captureLaunchError(noPrivateClient, {
    definition: "package-no-private",
  });
  assert.equal(noPrivateCaught, noPrivateFailure);
  await noPrivateClient.shutdown();
}

async function verifyContainerDiagnosticRedaction(tools, carrier) {
  const callsite = "callsite.package-container-private";
  const secretSymbol = Symbol("secret diagnostic");
  const lazySymbol = Symbol("lazy diagnostic");
  let symbolAccessorReads = 0;
  const symbolHeaders = new Headers({ "x-request-id": "request-public" });
  symbolHeaders[secretSymbol] = callsite;
  Object.defineProperty(symbolHeaders, lazySymbol, {
    configurable: true,
    get() {
      symbolAccessorReads += 1;
      return callsite;
    },
  });
  const symbolFailure = Object.assign(
    new TypeError("symbol transport failed"),
    {
      request: { headers: symbolHeaders },
    },
  );
  const symbolClient = tools.createClient({
    apiKey: "k",
    fetch: async () => {
      throw symbolFailure;
    },
  });
  const symbolCaught = await captureLaunchError(
    symbolClient,
    carrier.carryAgentRuntimeProvenance(
      { definition: "package-symbol-diagnostics" },
      { version: 1, callsite },
    ),
  );
  assert.notEqual(symbolCaught, symbolFailure);
  assert.equal(symbolCaught.request.headers[secretSymbol], undefined);
  assert.equal(
    Object.getOwnPropertyDescriptor(symbolCaught.request.headers, lazySymbol),
    undefined,
  );
  assert.equal(symbolAccessorReads, 0);
  assert.equal(symbolFailure.request.headers[secretSymbol], callsite);
  assert.equal(
    typeof Object.getOwnPropertyDescriptor(
      symbolFailure.request.headers,
      lazySymbol,
    ).get,
    "function",
  );
  await symbolClient.shutdown();

  let poisonedMethodReads = 0;
  let customGetterReads = 0;
  const poison = () => {
    poisonedMethodReads += 1;
    throw new Error("instance container method must not run");
  };
  const headers = new Headers({
    [CALLSITE_HEADER]: callsite,
    "x-request-id": "request-public",
  });
  Object.defineProperty(headers, "forEach", {
    configurable: true,
    value: poison,
  });
  const shared = { privateValue: callsite, publicValue: "shared-public" };
  const map = new Map([["shared", shared]]);
  const set = new Set([shared]);
  map.set("self", map);
  set.add(set);
  for (const [container, methods] of [
    [map, ["entries", "forEach", "set", Symbol.iterator]],
    [set, ["entries", "forEach", "add", Symbol.iterator]],
  ]) {
    for (const method of methods) {
      Object.defineProperty(container, method, {
        configurable: true,
        value: poison,
      });
    }
  }
  class OpaqueDiagnostic {
    constructor() {
      this.privateValue = callsite;
      this.publicValue = "opaque-public";
    }
  }
  const opaque = new OpaqueDiagnostic();
  const diagnostics = {
    request: { headers, requestId: "request-public" },
    map,
    set,
    opaque,
    publicValue: "diagnostic-public",
  };
  Object.defineProperty(diagnostics, "lazy", {
    configurable: true,
    get() {
      customGetterReads += 1;
      return callsite;
    },
  });
  const failure = Object.assign(new TypeError("container transport failed"), {
    code: "EAGENT",
    diagnostics,
  });
  const client = tools.createClient({
    apiKey: "k",
    fetch: async () => {
      throw failure;
    },
  });
  const caught = await captureLaunchError(
    client,
    carrier.carryAgentRuntimeProvenance(
      { definition: "package-container-diagnostics" },
      { version: 1, callsite },
    ),
  );

  assert.notEqual(caught, failure);
  assert.ok(caught instanceof TypeError);
  assert.equal(caught.code, "EAGENT");
  assert.equal(caught.diagnostics.request.requestId, "request-public");
  assert.equal(
    Headers.prototype.get.call(
      caught.diagnostics.request.headers,
      CALLSITE_HEADER,
    ),
    "[REDACTED runtime provenance]",
  );
  const caughtShared = Map.prototype.get.call(caught.diagnostics.map, "shared");
  assert.equal(
    Map.prototype.get.call(caught.diagnostics.map, "self"),
    caught.diagnostics.map,
  );
  assert.equal(
    Set.prototype.has.call(caught.diagnostics.set, caught.diagnostics.set),
    true,
  );
  assert.equal(
    Set.prototype.has.call(caught.diagnostics.set, caughtShared),
    true,
  );
  assert.equal(caughtShared.privateValue, "[REDACTED runtime provenance]");
  assert.equal(caughtShared.publicValue, "shared-public");
  assert.equal(caught.diagnostics.opaque, "[REDACTED runtime provenance]");
  assert.equal(caught.diagnostics.publicValue, "diagnostic-public");
  const lazyDescriptor = Object.getOwnPropertyDescriptor(
    caught.diagnostics,
    "lazy",
  );
  assert.equal(lazyDescriptor.value, "[REDACTED runtime provenance]");
  assert.equal("get" in lazyDescriptor, false);
  assert.equal("set" in lazyDescriptor, false);
  assert.equal(poisonedMethodReads, 0);
  assert.equal(customGetterReads, 0);
  assert.equal(Headers.prototype.get.call(headers, CALLSITE_HEADER), callsite);
  assert.equal(Map.prototype.get.call(map, "shared"), shared);
  assert.equal(Map.prototype.get.call(map, "self"), map);
  assert.equal(Set.prototype.has.call(set, set), true);
  assert.equal(shared.privateValue, callsite);
  assert.equal(opaque.privateValue, callsite);
  assert.equal(failure.diagnostics, diagnostics);
  await client.shutdown();
}

const cjsTools = require("@sapiom/tools");
const cjsCarrier = require(CARRIER_EXPORT);
const cjsSandboxes = require("@sapiom/tools/sandboxes");
const cjsRepositories = require("@sapiom/tools/repositories");
const cjsMemory = require("@sapiom/tools/memory");
const cjsFileStorage = require("@sapiom/tools/file-storage");
const cjsContentGeneration = require("@sapiom/tools/content-generation");
const cjsSearch = require("@sapiom/tools/search");
const cjsDatabase = require("@sapiom/tools/database");
const cjsRootSource = readFileSync(
  resolve(packageRoot, "dist/cjs/index.js"),
  "utf8",
);
assert.equal("default" in cjsTools, false);
assert.equal("default" in cjsCarrier, false);
assert.match(cjsRootSource, /require\("\.\/client\.js"\)/);
assert.doesNotMatch(cjsRootSource, /runtime-provenance\.cjs/);
assert.equal(cjsTools.Sandbox, cjsSandboxes.Sandbox);
assert.equal(cjsTools.Repository, cjsRepositories.Repository);
assert.equal(cjsTools.MemoryHttpError, cjsMemory.MemoryHttpError);
assert.equal(
  cjsTools.FileStorageHttpError,
  cjsFileStorage.FileStorageHttpError,
);
assert.equal(
  cjsTools.ContentGenerationHttpError,
  cjsContentGeneration.ContentGenerationHttpError,
);
assert.equal(cjsTools.SearchHttpError, cjsSearch.SearchHttpError);
assert.equal(cjsTools.DatabaseHttpError, cjsDatabase.DatabaseHttpError);
assert.equal(cjsTools.sandboxes.create, cjsSandboxes.create);
assert.equal(cjsTools.repositories.create, cjsRepositories.create);
assert.equal(cjsTools.memory.recall, cjsMemory.recall);
assert.equal(cjsTools.agents.launch.name, "launch");
assert.equal(cjsTools.agents.launch.length, 1);
assert.equal(cjsTools.agents.launch.constructor.name, "AsyncFunction");
const cjsClientModules = Object.values(require.cache).filter((loaded) =>
  loaded?.filename.endsWith("/dist/cjs/_client/index.js"),
);
assert.equal(cjsClientModules.length, 1);
assert.equal(
  cjsClientModules[0].exports.defaultTransport(),
  cjsClientModules[0].exports.defaultTransport(),
);
assert.throws(
  () => require("@sapiom/tools/dist/cjs/agents/runtime-callsite-store.js"),
  (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
);
await verifySameFormat("cjs", cjsTools, cjsCarrier);
await verifyNativeErrorStackRedaction(cjsTools, cjsCarrier);
await verifyContainerDiagnosticRedaction(cjsTools, cjsCarrier);

const esmTools = await import("@sapiom/tools");
const esmCarrier = await import(CARRIER_EXPORT);
const esmSandboxes = await import("@sapiom/tools/sandboxes");
const esmRepositories = await import("@sapiom/tools/repositories");
const esmMemory = await import("@sapiom/tools/memory");
const esmFileStorage = await import("@sapiom/tools/file-storage");
const esmContentGeneration = await import("@sapiom/tools/content-generation");
const esmSearch = await import("@sapiom/tools/search");
const esmDatabase = await import("@sapiom/tools/database");
await assert.rejects(
  import("@sapiom/tools/dist/esm/agents/runtime-callsite-store.js"),
  (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
);
assert.equal("default" in esmTools, false);
assert.equal("default" in esmCarrier, false);
assert.deepEqual(Object.keys(esmTools).sort(), Object.keys(cjsTools).sort());
assert.equal(esmTools.Sandbox, esmSandboxes.Sandbox);
assert.equal(esmTools.Repository, esmRepositories.Repository);
assert.equal(esmTools.MemoryHttpError, esmMemory.MemoryHttpError);
assert.equal(
  esmTools.FileStorageHttpError,
  esmFileStorage.FileStorageHttpError,
);
assert.equal(
  esmTools.ContentGenerationHttpError,
  esmContentGeneration.ContentGenerationHttpError,
);
assert.equal(esmTools.SearchHttpError, esmSearch.SearchHttpError);
assert.equal(esmTools.DatabaseHttpError, esmDatabase.DatabaseHttpError);
assert.equal(esmTools.sandboxes.create, esmSandboxes.create);
assert.equal(esmTools.repositories.create, esmRepositories.create);
assert.equal(esmTools.memory.recall, esmMemory.recall);
assert.equal(esmTools.agents.launch.name, "launch");
assert.equal(esmTools.agents.launch.length, 1);
assert.equal(esmTools.agents.launch.constructor.name, "AsyncFunction");
assert.equal(
  esmCarrier.carryAgentRuntimeProvenance,
  cjsCarrier.carryAgentRuntimeProvenance,
);
await verifySameFormat("esm", esmTools, esmCarrier);

const esmRootSource = readFileSync(
  resolve(packageRoot, "dist/esm/index.js"),
  "utf8",
);
assert.match(esmRootSource, /from "\.\/client\.js"/);
assert.match(esmRootSource, /export \* as agents from "\.\/agents\/index\.js"/);
assert.doesNotMatch(esmRootSource, /\.\.\/cjs\/index\.js/);
assert.doesNotMatch(esmRootSource, /runtime-provenance\.cjs/);

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

for (const format of ["cjs", "esm"]) {
  for (const extension of [".js", ".js.map", ".d.ts", ".d.ts.map"]) {
    assert.equal(
      existsSync(
        resolve(
          packageRoot,
          `dist/${format}/agents/runtime-callsite-store${extension}`,
        ),
      ),
      false,
    );
  }
}

const loadedToolsModules = Object.values(require.cache).filter((loaded) =>
  loaded?.filename.includes("/packages/tools/dist/"),
);
const loadedExportNames = loadedToolsModules.flatMap((loaded) =>
  Object.keys(loaded?.exports ?? {}),
);
const forbiddenHelperNames = [
  "registerAgentRuntimeCallsite",
  "takeAgentRuntimeCallsite",
];
for (const name of forbiddenHelperNames) {
  assert.equal(loadedExportNames.includes(name), false);
}
const supportedProvenanceCacheExports = new Set([
  ...Object.keys(cjsTools),
  ...Object.keys(cjsTools.agents),
  ...Object.keys(cjsCarrier),
]);
const loadedProvenanceModules = loadedToolsModules.filter(
  (loaded) =>
    loaded.filename.endsWith("/agents/index.js") ||
    loaded.filename.includes("agent-runtime-provenance") ||
    loaded.filename.includes("runtime-provenance.cjs"),
);
for (const loaded of loadedProvenanceModules) {
  assert.deepEqual(
    Object.keys(loaded.exports).filter(
      (name) => !supportedProvenanceCacheExports.has(name),
    ),
    [],
    `unsupported cache exports from ${loaded.filename}`,
  );
}

const attackSource = cjsCarrier.carryAgentRuntimeProvenance(
  { definition: "cache-attack-source" },
  { version: 1, callsite: "callsite.cache-attack" },
);
const cachedTake = loadedToolsModules
  .map((loaded) => loaded.exports?.takeAgentRuntimeCallsite)
  .find(Boolean);
const cachedRegister = loadedToolsModules
  .map((loaded) => loaded.exports?.registerAgentRuntimeCallsite)
  .find(Boolean);
assert.equal(cachedTake, undefined);
assert.equal(cachedRegister, undefined);
const reboundSpec = { definition: "cache-attack-rebound" };
if (cachedTake && cachedRegister) {
  cachedRegister(reboundSpec, 1, cachedTake(attackSource));
}
const attackServer = fakeAgentServer();
const attackClient = cjsTools.createClient({
  apiKey: "k",
  fetch: attackServer.fetch,
});
await attackClient.agents.launch(reboundSpec);
const attackPost = attackServer.calls.find(
  (call) => call.init.method === "POST",
);
assert.equal(header(attackPost, CALLSITE_HEADER), null);
await attackClient.shutdown();

async function verifyStubSurface(label, stubModule) {
  assert.equal("default" in stubModule, false);
  assert.equal(typeof stubModule.createStubClient, "function");
  const stub = stubModule.createStubClient();
  const runResult = await stub.agents.run({
    definition: `${label}-stub-run`,
  });
  assert.equal(runResult.status, "completed");
  const handle = await stub.agents.launch({
    definition: `${label}-stub-launch`,
  });
  assert.equal(handle.dispatch.resultSignal, cjsTools.AGENTS_RESULT_SIGNAL);
  assert.equal((await handle.wait()).status, "completed");
  await stub.shutdown();
}

const cjsStub = require("@sapiom/tools/stub");
const esmStub = await import("@sapiom/tools/stub");
await verifyStubSurface("cjs", cjsStub);
await verifyStubSurface("esm", esmStub);

const loadedAfterStub = Object.values(require.cache).filter((loaded) =>
  loaded?.filename.includes("/packages/tools/dist/"),
);
for (const loaded of loadedAfterStub) {
  for (const name of forbiddenHelperNames) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(loaded.exports ?? {}, name),
      false,
      `private helper ${name} exposed by ${loaded.filename}`,
    );
  }
}

console.log(
  "runtime provenance package surfaces: fail-closed diagnostics, native Error stacks, native roots, constructor identity, cache-private CJS + ESM, four cross-format paths, and both stub formats passed",
);
