import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Resolve EVERYTHING from the external consumer, not this script's workspace.
const consumer = process.cwd();
const require = createRequire(join(consumer, "package.json"));
const entry = require.resolve("@sapiom/mcp");
assert((await realpath(entry)).startsWith(consumer));
const installed = createRequire(entry);
const load = (name) => import(pathToFileURL(installed.resolve(name)).href);
const { Client } = await load("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await load(
  "@modelcontextprotocol/sdk/client/stdio.js",
);
const { McpCapabilitiesSchema, STUDIO_HOST_CONTEXT_ENV } =
  await import("@sapiom/agent-map/host-protocol");
const { StudioHostContextClient } = await import(
  pathToFileURL(join(dirname(entry), "studio-host-context.js")).href
);
const descriptor = McpCapabilitiesSchema.parse(
  JSON.parse(
    execFileSync(process.execPath, [entry, "--describe-capabilities"], {
      cwd: consumer,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16_384,
      windowsHide: true,
      env: { PATH: process.env.PATH, SAPIOM_ENVIRONMENT: "does-not-exist" },
    }),
  ),
);
assert.deepEqual(descriptor.features, ["studio-context"]);
assert.deepEqual(descriptor.hostProtocolVersions, [1]);
const token = "private-installed-fixture-capability";
let status = 200;
let requests = 0;
const context = {
  protocolVersion: 1,
  host: "sapiom-studio",
  stateRoot: join(consumer, "custom-state"),
  projectId: "project_00000000-0000-4000-8000-000000000001",
  userId: "local:machine",
  sessionId: "session",
  generation: 1,
  capabilities: ["session-context"],
};
const host = createServer((request, response) => {
  requests++;
  assert.equal(request.url, "/mcp/agent-map/host-context");
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  response.setHeader("Cache-Control", "no-store");
  response.writeHead(status).end(JSON.stringify(context));
});
await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
try {
  const bootstrap = {
    contextUrl: `http://127.0.0.1:${host.address().port}/mcp/agent-map/host-context`,
    bearerToken: token,
    expectedMcp: descriptor,
  };
  const env = { [STUDIO_HOST_CONTEXT_ENV]: JSON.stringify(bootstrap) };
  assert.deepEqual(await new StudioHostContextClient({}).resolve(), {
    kind: "standalone",
  });
  assert.deepEqual(
    await new StudioHostContextClient({
      SAPIOM_HARNESS_VERSION: "old",
    }).resolve(),
    { kind: "legacy-studio" },
  );
  const client = new StudioHostContextClient(env);
  assert.deepEqual(await client.resolve(), { kind: "studio", context });
  status = 401;
  assert.equal((await client.resolve()).kind, "unavailable-studio");
  status = 200;
  context.generation++;
  assert.deepEqual(await client.resolve(), {
    kind: "unavailable-studio",
    reason: "scope-changed",
  });
  context.generation--;
  const serverFile = join(dirname(entry), "server.js");
  const original = await readFile(serverFile, "utf8");
  try {
    // Same version/entry, changed implementation: actual startup must reject the
    // preflight fingerprint before using a bearer, not just trust a version tag.
    await writeFile(serverFile, original + "\n// changed installed artifact\n");
    const before = requests;
    assert.deepEqual(await new StudioHostContextClient(env).resolve(), {
      kind: "unavailable-studio",
      reason: "artifact-changed",
    });
    assert.equal(requests, before);
  } finally {
    await writeFile(serverFile, original);
  }

  const testHome = join(consumer, "test-home");
  await mkdir(join(testHome, ".sapiom"), { recursive: true });
  await writeFile(
    join(testHome, ".sapiom/credentials.json"),
    JSON.stringify({
      currentEnvironment: "test",
      environments: {
        test: { appURL: "http://127.0.0.1:9", apiURL: "http://127.0.0.1:9" },
      },
    }),
  );
  for (const [mode, hostEnv] of [
    ["standalone", {}],
    ["old-studio", { SAPIOM_HARNESS_VERSION: "old" }],
    ["new-studio", env],
    ["unavailable-studio", env],
  ]) {
    status = mode === "unavailable-studio" ? 401 : 200;
    let stderr = "";
    let tokenLeaked = false;
    let unavailableWarning = false;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      cwd: consumer,
      stderr: "pipe",
      env: {
        HOME: testHome,
        USERPROFILE: testHome,
        SAPIOM_ENVIRONMENT: "test",
        SAPIOM_TELEMETRY_DISABLED: "1",
        ...hostEnv,
      },
    });
    transport.stderr?.on("data", (chunk) => {
      const text = stderr + chunk;
      tokenLeaked ||= text.includes(token);
      unavailableWarning ||= text.includes("Studio map context unavailable");
      stderr = text.slice(-16_384);
    });
    const stdio = new Client({ name: "installed-contract", version: "1" });
    try {
      await stdio.connect(transport, { timeout: 8_000 });
      const tools = (await stdio.listTools()).tools;
      assert.equal(tools.length, 25);
      assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
      assert(
        !tools.some((tool) => /(?:agent_map|sapiom_dev_map)/.test(tool.name)),
      );
      assert(!/sapiom_dev_(?:agent_)?map/.test(stdio.getInstructions() ?? ""));
      assert.equal(unavailableWarning, mode === "unavailable-studio");
    } finally {
      await stdio.close();
      assert(!tokenLeaked);
    }
  }
  console.log(
    "Installed probe, revalidation, replaced-artifact rejection and four stdio launch modes passed.",
  );
} finally {
  host.closeAllConnections();
  await new Promise((resolve) => host.close(resolve));
}
