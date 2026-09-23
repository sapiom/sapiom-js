import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { McpCapabilitiesSchema } from "@sapiom/agent-map/host-protocol";

it("built entry describes support without importing the normal server or contacting services", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "mcp-probe-"));
  try {
    // Node 18 supports ESM loader hooks. Any normal startup import is fatal.
    const loader = join(temporary, "offline-loader.mjs");
    await writeFile(
      loader,
      `export async function resolve(specifier, context, next) {
      if (/server\\.js$|credentials|analytics|instructions|node:(http|https|net)|@modelcontextprotocol/.test(specifier))
        throw new Error("Unexpected startup import: " + specifier);
      return next(specifier, context);
    }`,
    );
    const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-loader",
        loader,
        entry,
        "--describe-capabilities",
      ],
      {
        cwd: temporary,
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 16_384,
        windowsHide: true,
        env: { PATH: process.env.PATH, SAPIOM_ENVIRONMENT: "invalid/no/auth" },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const descriptor = McpCapabilitiesSchema.parse(JSON.parse(result.stdout));
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    assert.equal(pkg.sapiomCapabilities, 1);
    assert.equal(descriptor.packageVersion, pkg.version);
    assert.deepEqual(descriptor.features, ["studio-context"]);
    assert.deepEqual(descriptor.hostProtocolVersions, [1]);
    assert.deepEqual(descriptor.mapSchemaVersions, [1]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
