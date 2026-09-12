// Opt-in paid probe against the signed-in Studio account; never run in CI.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectStudioSystem } from "./assistant-context-projection.mjs";
import { measurementFailures } from "./assistant-context-measurements.mjs";

assert.equal(
  process.env.SAPIOM_CONTEXT_GATEWAY_PROBE,
  "1",
  "Set SAPIOM_CONTEXT_GATEWAY_PROBE=1 to opt into paid fixture requests",
);
const sdk = resolve(process.argv[2] ?? ".");
const output = resolve(process.argv[3] ?? "context-gateway.json");
const source = (path) => import(pathToFileURL(join(sdk, path)).href);
const { default: express } = await source(
  "packages/harness/node_modules/express/index.js",
);
const { resolveEnvironment } = await source("packages/mcp/dist/auth-api.js");
const { OpenCodeBridge, assistantUpstreams } = await source(
  "packages/harness/src/server/opencode-bridge.ts",
);
const { startOpenCodeServer } = await source("packages/opencode/src/server.ts");
const { createSapiomOpenCodeConfig } = await source(
  "packages/opencode/src/config.ts",
);
const { composeAssistantPrompt, recoverAssistantPrompt } = await source(
  "packages/harness/src/core/studio-assistant-context.ts",
);
const { assistantProfile } = await source(
  "packages/harness/src/profiles/assistant.ts",
);
const environment = await resolveEnvironment("production");
const endpoint = assistantUpstreams(environment).llm.href;
assert.equal(
  endpoint,
  "https://router.sapiom.ai/v1/responses",
  "Measure the supported Luna Responses route",
);
const root = await mkdtemp(join(tmpdir(), "studio-gateway-assessment-"));
const modeFile = join(root, "projection-enabled");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const systemText = (body) =>
  (body.input ?? [])
    .filter((m) => ["system", "developer"].includes(m.role))
    .flatMap((m) =>
      typeof m.content === "string"
        ? [m.content]
        : m.content.map((p) => p.text ?? ""),
    )
    .join("\n");
const common = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};
let phase = "setup",
  projected = false,
  completed = false,
  sourceReads = 0,
  runtime,
  bridge,
  server,
  previousSystem = "";
const calls = [],
  sources = [],
  steps = [],
  pending = [],
  failures = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith("/v1/harness/system-prompt")) {
    sourceReads++;
    const start = performance.now();
    const response = await originalFetch(url, init);
    pending.push(
      response
        .clone()
        .arrayBuffer()
        .then((value) => {
          const bytes = Buffer.from(value);
          sources.push({
            phase,
            status: response.status,
            bytes: bytes.length,
            digest: digest(bytes),
            elapsedMs: performance.now() - start,
            cacheControl: response.headers.get("cache-control"),
          });
        })
        .catch((error) => sources.push({ phase, error: error.name })),
    );
    return response;
  }
  if (String(url) !== endpoint) return originalFetch(url, init);
  const body = JSON.parse(Buffer.from(init.body).toString());
  const system = systemText(body),
    start = performance.now();
  const row = {
    phase,
    projected,
    requestedModel: body.model,
    reasoningEffort: body.reasoning?.effort ?? null,
    store: body.store,
    cacheKeyDigest: body.prompt_cache_key
      ? digest(body.prompt_cache_key)
      : null,
    requestBytes: Buffer.byteLength(JSON.stringify(body)),
    systemCharacters: system.length,
    commonSystemPrefixCharacters: common(previousSystem, system),
    systemDigest: digest(system),
    toolsDigest: digest(JSON.stringify(body.tools ?? [])),
    sourceReads,
    completionOffset: system.indexOf("StudioAssistantResult/v2:"),
    guidanceOffset: system.indexOf("Studio guidance:"),
    usage: null,
    status: null,
    servedModel: null,
    serviceTier: null,
    firstTextMs: null,
    cachedInput: null,
    cacheWrite: null,
    inputMinusCacheReads: null,
  };
  previousSystem = system;
  calls.push(row);
  const response = await originalFetch(url, init);
  row.httpStatus = response.status;
  row.headersMs = performance.now() - start;
  const observed = (async () => {
    const reader = response.clone().body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]")
          continue;
        const event = JSON.parse(line.slice(5));
        if (
          event.type === "response.output_text.delta" &&
          row.firstTextMs === null
        )
          row.firstTextMs = performance.now() - start;
        if (
          [
            "response.completed",
            "response.incomplete",
            "response.failed",
          ].includes(event.type)
        ) {
          const result = event.response;
          row.status = result.status;
          row.servedModel = result.model ?? null;
          row.serviceTier = result.service_tier ?? null;
          row.usage = result.usage ?? null;
          const input = result.usage?.input_tokens,
            detail = result.usage?.input_tokens_details;
          row.cachedInput = detail?.cached_tokens ?? null;
          row.cacheWrite = detail?.cache_write_tokens ?? null;
          row.inputMinusCacheReads =
            input != null && row.cachedInput != null
              ? input - row.cachedInput
              : null;
        }
      }
      if (done) break;
    }
    row.elapsedMs = performance.now() - start;
  })().catch((error) => {
    row.observationError = error.name;
  });
  pending.push(observed);
  return response;
};
// Eligibility is a fixture, as in the native bridge tests. The production
// gateway independently authenticates the real signed-in API key. This probe
// does not certify Studio browser sign-in/eligibility or alter its feature gate.
assert.ok(
  environment.credentials?.apiKey,
  "A signed-in gateway API key is required",
);
const grant = {
  userId: "context-fixture",
  tenantId: "context-fixture",
  identityRevision: "fixture",
  expiresAt: Date.now() + 900_000,
  environment,
};
const access = { get: () => grant, subscribe: () => () => {} };
const request = (path, body) =>
  runtime.fetchJson(path, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(90_000),
  });
try {
  bridge = new OpenCodeBridge(access, "gpt-luna");
  const app = express();
  app.use("/bridge", bridge.router);
  app.all("/fixture-mcp", express.json(), (req, res) => {
    if (req.method === "GET") return res.status(405).end();
    if (req.body.id === undefined) return res.status(202).end();
    res.json({
      jsonrpc: "2.0",
      id: req.body.id,
      result:
        req.body.method === "initialize"
          ? {
              protocolVersion: req.body.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : { tools: [] },
    });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const credential = bridge.issue();
  const config = createSapiomOpenCodeConfig({
    bridgeUrl: `${origin}/bridge/${credential.id}`,
    runtimeToken: credential.token,
  });
  config.mcp.sapiom.url = `${origin}/fixture-mcp`;
  await writeFile(modeFile, "0");
  runtime = await startOpenCodeServer({
    cwd: root,
    stateRoot: join(root, "native"),
    config,
    startupTimeoutMs: 30_000,
    beforeLaunch: async () => {
      for (const entry of await readdir(join(root, "native"))) {
        if (!entry.startsWith("launch-")) continue;
        const file = join(root, "native", entry, "credential-isolation.mjs");
        const text = await readFile(file, "utf8");
        assert.ok(text.includes("...completionHooks,"));
        await writeFile(
          file,
          text.replace(
            "...completionHooks,",
            `...completionHooks, 'experimental.chat.system.transform': async (_input, output) => { if ((await readProjectionFlag(new URL('../../projection-enabled', import.meta.url), 'utf8')) === '1') output.system.splice(0, output.system.length, ...output.system.map(projectStudioSystem)); },`,
          ) +
            `\nimport { readFile as readProjectionFlag } from 'node:fs/promises';\n${projectStudioSystem.toString()}\n`,
        );
      }
    },
  });
  const session = await request("/session", {
    title: "Gateway context assessment",
  });
  const resolvePrompt = async (target, revision) => {
    const profile = await assistantProfile(environment);
    return composeAssistantPrompt({
      schemaVersion: 1,
      revision,
      session: {
        id: "fixture-studio",
        cwd: root,
        projectId: "fixture-project",
      },
      environment: "production",
      selectedAgent: {
        status: "available",
        agent: { name: target, path: join(root, target), definitionId: null },
      },
      boundAgent: { status: "none" },
      agents: [],
      capabilities: [{ name: "fixture-mcp", status: "available", tools: [] }],
      guidance: [profile],
    });
  };
  let accepted;
  for (const name of [
    "cold",
    "followup-1",
    "followup-2",
    "selection-change",
    "projected-1",
    "projected-2",
    "projected-3",
    "recovery",
    "compaction",
  ]) {
    phase = name;
    if (name === "projected-1") {
      projected = true;
      await writeFile(modeFile, "1");
    }
    const before = calls.length;
    if (name === "compaction")
      await request(`/session/${session.id}/summarize`, {
        providerID: "sapiom",
        modelID: "gpt-luna",
        auto: true,
      });
    else {
      accepted =
        name === "recovery"
          ? recoverAssistantPrompt(accepted.system)
          : await resolvePrompt(
              name === "cold" || name.startsWith("followup")
                ? "Cedar"
                : "Orchid",
              name === "cold" || name.startsWith("followup") ? "V1" : "V2",
            );
      await request(`/session/${session.id}/message`, {
        ...accepted,
        model: { providerID: "sapiom", modelID: "gpt-luna" },
        parts: [
          {
            type: "text",
            text: "This is a harmless context fixture. Do not use tools, read files, or change anything. Reply with the required completion marker and the single word ACK.",
          },
        ],
      });
    }
    await Promise.all(pending);
    const history = await request(`/session/${session.id}/message`);
    const last = history.findLast((m) => m.info.role === "assistant");
    const phaseCalls = calls.slice(before);
    steps.push({
      phase,
      requests: phaseCalls.length,
      sourceReads,
      nativeTokens: last?.info.tokens ?? null,
      nativeError: last?.info.error?.name ?? null,
    });
    if (
      !phaseCalls.length ||
      phaseCalls.some((c) => c.httpStatus !== 200 || c.status !== "completed")
    )
      failures.push(name);
    console.log(
      JSON.stringify({
        phase,
        attempts: phaseCalls.length,
        sourceReads,
        usage: phaseCalls.map((c) => c.usage),
      }),
    );
  }
  failures.push(...measurementFailures({ sourceReads, sources, calls }));
  assert.deepEqual(
    failures,
    [],
    "Every scenario must reach a completed provider response",
  );
  completed = true;
} finally {
  await runtime?.close();
  bridge?.close();
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  await Promise.all(pending);
  globalThis.fetch = originalFetch;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        endpoint,
        sdkHead: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: sdk,
          encoding: "utf8",
        }).trim(),
        evidence:
          "real native runtime and Studio credential bridge with real gateway authentication; fixture eligibility/MCP; actual served profile; test-only projection toggled within one native session",
        sourceReads,
        sources,
        completed,
        steps,
        calls,
        failures,
      },
      null,
      2,
    ) + "\n",
  );
  await rm(root, { recursive: true, force: true });
}
