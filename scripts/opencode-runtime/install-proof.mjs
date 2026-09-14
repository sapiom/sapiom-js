import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  lstat,
  stat,
  rm,
  appendFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const artifacts = resolve(process.argv[2]);
const work = resolve(process.argv[3]);
const pnpm = process.env.PNPM_SCRIPT;
assert.ok(pnpm, "Set PNPM_SCRIPT to the installed pnpm 10.34.3 bin/pnpm.cjs");
const proof = JSON.parse(
  await readFile(join(artifacts, "release-proof.json"), "utf8"),
);
const version = proof.nativeInputs.runtimeVersion;
const fixtureScript = fileURLToPath(
  new URL("./install-fixture.py", import.meta.url),
);
const python = process.env.PYTHON ?? "python3";
await mkdir(work); // Refuse leftover fixture state.
await mkdir(join(work, "tmp"));
const sha = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
const exists = async (file) => {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
const requests = [],
  results = [];
const files = new Map();
for (const item of Object.values(proof.artifacts)) {
  const path = join(artifacts, item.artifact);
  assert.equal(await sha(path), item.sha256);
  files.set(`/${item.artifact}`, path);
}
async function command(executable, args, cwd, failure = false) {
  const child = spawn(executable, args, {
    cwd,
    windowsHide: true,
    env: {
      ...process.env,
      CI: "true",
      TMPDIR: join(work, "tmp"),
      TEMP: join(work, "tmp"),
      TMP: join(work, "tmp"),
      npm_config_cache: join(work, "npm-cache"),
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_fetch_retries: "0",
      npm_config_fetch_timeout: "15000",
      OPENCODE_POISON_MARKER: join(work, "poison-executed"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180_000,
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((done, reject) => {
    child.on("error", reject);
    child.on("close", done);
  });
  await appendFile(
    join(work, "commands.log"),
    JSON.stringify({ executable, args, cwd, code, stdout, stderr }) + "\n",
  );
  if (!failure) assert.equal(code, 0, `${executable}\n${stdout}\n${stderr}`);
  return { code, stdout, stderr };
}
const server = createServer(async (req, res) => {
  try {
    requests.push(req.url);
    const file = files.get(req.url);
    if (!file || !["GET", "HEAD"].includes(req.method))
      return res.writeHead(404).end();
    res.writeHead(200, { "Content-Length": (await stat(file)).size });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  } catch {
    res.writeHead(500).end();
  }
});
let binary, selected;
try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}/`;
  assert.equal(
    (await command(process.execPath, [pnpm, "--version"], work)).stdout.trim(),
    "10.34.3",
  );
  const root = join(artifacts, proof.artifacts["opencode-ai"].artifact);
  const rootSha = await sha(root);
  async function makeFixture(name, override) {
    const output = join(work, `${name}.tgz`);
    const options = [];
    if (override) {
      const path = join(work, `${name}-override.json`);
      await writeFile(path, JSON.stringify({ [selected]: override }));
      options.push("--override", path);
    }
    await command(
      python,
      [
        fixtureScript,
        "--artifacts",
        artifacts,
        "--output",
        output,
        "--base-url",
        base,
        ...options,
      ],
      work,
    );
    files.set(`/${name}.tgz`, output);
    const dir = join(work, name);
    await mkdir(dir);
    const url = `${base}${name}.tgz`;
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "runtime-fixture",
        private: true,
        version: "1.0.0",
        dependencies: { "opencode-ai": url },
      }),
    );
    await writeFile(
      join(dir, "pnpm-workspace.yaml"),
      `onlyBuiltDependencies:\n  - ${JSON.stringify(`opencode-ai@${url}`)}\n`,
    );
    return dir;
  }
  for (const ignore of [false, true]) {
    const name = ignore ? "ignored-scripts" : "fresh-install";
    const dir = await makeFixture(name);
    const begin = requests.length;
    await command(
      process.execPath,
      [
        pnpm,
        "install",
        "--reporter=append-only",
        "--store-dir",
        join(dir, "store"),
        ...(ignore ? ["--ignore-scripts"] : []),
      ],
      dir,
    );
    const installed = join(dir, "node_modules/opencode-ai");
    binary = join(installed, "bin/opencode.exe");
    if (ignore) {
      assert.equal(await sha(binary), proof.packaging.launcherStubSha256);
      assert.deepEqual([...new Set(requests.slice(begin))], [`/${name}.tgz`]);
      // The preserved shell stub also fails closed on Windows, where it is not an executable.
      if (process.platform !== "win32")
        assert.equal((await command(binary, ["--version"], dir, true)).code, 1);
      await command(
        process.execPath,
        [join(installed, "postinstall.mjs")],
        installed,
      );
    }
    const binarySha256 = await sha(binary);
    selected = Object.keys(proof.artifacts).find(
      (name) => proof.artifacts[name].binarySha256 === binarySha256,
    );
    assert.ok(selected, "Installed binary must match a verified build output");
    const platforms = [
      ...new Set(
        requests.slice(begin).filter((path) => path !== `/${name}.tgz`),
      ),
    ];
    assert.deepEqual(platforms, [`/${proof.artifacts[selected].artifact}`]);
    assert.equal(
      await sha(join(installed, "postinstall.mjs")),
      proof.packaging.postinstallSha256,
    );
    const metadata = JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    );
    assert.equal(metadata.dependencies, undefined);
    assert.equal(metadata.optionalDependencies, undefined);
    const actualVersion = (
      await command(binary, ["--version"], dir)
    ).stdout.trim();
    assert.equal(actualVersion, version);
    results.push({
      name,
      selected,
      binarySha256,
      actualVersion,
      requested: requests.slice(begin),
    });
    if (!ignore) await rm(dir, { recursive: true, force: true });
  }
  const poison = join(work, "poison.tgz");
  await command(
    python,
    [
      fixtureScript,
      "--artifacts",
      artifacts,
      "--output",
      poison,
      "--base-url",
      base,
      "--poison-platform",
      selected,
    ],
    work,
  );
  files.set("/poison.tgz", poison);
  const expected = proof.artifacts[selected];
  for (const item of [
    {
      name: "wrong-hash",
      artifact: {
        url: base + "poison.tgz",
        binarySha256: expected.binarySha256,
      },
      error: /does not match its pinned hash/,
      requested: "/poison.tgz",
    },
    {
      name: "missing-hash",
      artifact: { url: base + expected.artifact },
      error: /Invalid pinned OpenCode runtime artifact metadata/,
    },
    {
      name: "missing-archive",
      artifact: {
        url: base + "missing.tgz",
        binarySha256: expected.binarySha256,
      },
      error: /Could not install the pinned OpenCode runtime artifact/,
      requested: "/missing.tgz",
    },
  ]) {
    const dir = await makeFixture(item.name, item.artifact);
    await command(
      process.execPath,
      [pnpm, "install", "--ignore-scripts", "--store-dir", join(dir, "store")],
      dir,
    );
    const installed = join(dir, "node_modules/opencode-ai");
    const begin = requests.length;
    const result = await command(
      process.execPath,
      [join(installed, "postinstall.mjs")],
      installed,
      true,
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, item.error);
    assert.equal(
      await sha(join(installed, "bin/opencode.exe")),
      proof.packaging.launcherStubSha256,
    );
    assert.equal(await exists(join(work, "poison-executed")), false);
    assert.deepEqual(
      [...new Set(requests.slice(begin))],
      item.requested ? [item.requested] : [],
    );
    results.push({
      name: item.name,
      code: result.code,
      requested: requests.slice(begin),
      poisonNeverExecuted: true,
    });
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(await sha(root), rootSha);
  const result = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    version,
    candidateRootSha256: rootSha,
    selected,
    binary,
    results,
  };
  await writeFile(
    join(work, "install-proof.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  if (process.env.GITHUB_ENV)
    await appendFile(
      process.env.GITHUB_ENV,
      `SAPIOM_OPENCODE_CONTEXT_TEST_BINARY=${binary}\n`,
    );
  console.log(JSON.stringify(result));
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
