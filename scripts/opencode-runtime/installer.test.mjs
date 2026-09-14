import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";

// Supply the patched installer produced by pack.py, not a second implementation.
const installer = await readFile(process.argv[2]);
const manifest = JSON.parse(await readFile(new URL("../../packages/opencode/native-runtime.json", import.meta.url)));
const base = `https://github.com/sapiom/sapiom-js/releases/download/opencode-runtime-v${manifest.runtimeVersion}/`;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const metadata = Object.fromEntries(manifest.platforms.map((name) => [name, {
  url: `${base}${name}-${manifest.runtimeVersion}.tgz`, binarySha256: sha(name),
}]));
const matrix = [
  ["linux", "x64", false, true, "opencode-linux-x64"],
  ["linux", "x64", false, false, "opencode-linux-x64-baseline"],
  ["linux", "x64", true, true, "opencode-linux-x64-musl"],
  ["linux", "x64", true, false, "opencode-linux-x64-baseline-musl"],
  ["linux", "arm64", false, false, "opencode-linux-arm64"],
  ["linux", "arm64", true, false, "opencode-linux-arm64-musl"],
  ["darwin", "x64", false, true, "opencode-darwin-x64"],
  ["darwin", "x64", false, false, "opencode-darwin-x64-baseline"],
  ["darwin", "arm64", false, false, "opencode-darwin-arm64"],
  ["win32", "x64", false, true, "opencode-windows-x64"],
  ["win32", "x64", false, false, "opencode-windows-x64-baseline"],
  ["win32", "arm64", false, false, "opencode-windows-arm64"],
].map(([platform, arch, musl, avx2, expected]) => ({ platform, arch, musl, avx2, expected }));
const linux = { platform: "linux", arch: "x64", musl: false, avx2: true };
const scenarios = [
  ...matrix,
  { ...linux, reject: "opencode-linux-x64", expected: "opencode-linux-x64-baseline" },
  { ...linux, forceCopy: true, expected: "opencode-linux-x64" },
  { ...linux, missingAll: true },
  { ...linux, platform: "win32", missingAll: true },
  { ...linux, platform: "win32", missingAll: true, noNpmCLI: true },
  ...["missing-hash", "wrong-hash", "unsafe-url", "symlink"].map((invalid) => ({ ...linux, invalid })),
];

for (const [index, scenario] of scenarios.entries()) {
  test(`installer simulation ${index + 1}: ${JSON.stringify(scenario)}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-selector-"));
    try {
      await writeFile(join(root, "postinstall.mjs"), installer);
      const artifacts = structuredClone(metadata);
      const selected = artifacts["opencode-linux-x64"];
      if (scenario.invalid === "missing-hash") delete selected.binarySha256;
      if (scenario.invalid === "wrong-hash") selected.binarySha256 = "0".repeat(64);
      if (scenario.invalid === "unsafe-url") selected.url = "http://example.invalid/runtime.tgz";
      await writeFile(join(root, "package.json"), JSON.stringify({
        name: "opencode-ai", version: manifest.runtimeVersion, sapiomRuntimeArtifacts: artifacts,
      }));
      if (!scenario.missingAll) for (const name of manifest.platforms) {
        const pkg = join(root, "node_modules", name);
        await mkdir(join(pkg, "bin"), { recursive: true });
        await writeFile(join(pkg, "package.json"), JSON.stringify({ name, version: manifest.runtimeVersion }));
        const binary = join(pkg, "bin", name.includes("windows") ? "opencode.exe" : "opencode");
        await writeFile(binary, name);
        if (scenario.invalid === "symlink" && name === "opencode-linux-x64") {
          const { symlink } = await import("node:fs/promises");
          await rm(binary);
          await symlink(join(pkg, "package.json"), binary);
        }
      }
      const result = spawnSync(process.execPath, ["--import",
        fileURLToPath(new URL("./installer-fixture.mjs", import.meta.url)), join(root, "postinstall.mjs")], {
        cwd: root, encoding: "utf8", env: { ...process.env, OPENCODE_INSTALLER_FIXTURE: root,
          OPENCODE_INSTALLER_SCENARIO: JSON.stringify(scenario) },
      });
      const calls = JSON.parse(await readFile(join(root, "calls.json"), "utf8"));
      assert.equal(result.status, scenario.missingAll || scenario.invalid ? 1 : 0, result.stderr);
      if (scenario.invalid || scenario.noNpmCLI) {
        assert.deepEqual(calls, []); // Invalid bytes/metadata are never executed or retried.
        assert.match(result.stderr, /pinned|Pinned/);
      } else if (scenario.missingAll) {
        assert.equal(calls.length, 1);
        assert.equal(calls[0].shell, false);
        assert.ok(calls[0].npm.includes("--ignore-scripts"));
        assert.match(calls[0].npm.at(-1), /@https:\/\/github.com\/sapiom\/sapiom-js\//);
        if (scenario.platform === "win32") {
          assert.equal(calls[0].command, process.execPath);
          assert.ok(calls[0].npm[0].endsWith("npm-cli.js"));
        }
      } else {
        assert.equal(calls.at(-1).selected, scenario.expected);
        assert.equal(await readFile(join(root, "bin/opencode.exe"), "utf8"), scenario.expected);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
