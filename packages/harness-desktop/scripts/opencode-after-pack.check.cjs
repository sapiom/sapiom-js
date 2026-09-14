const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { prepare } = require("./opencode-after-pack.cjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let root, resources, owner, runtime, binary, source, context, calls;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "signed-native-fixture-")));
  resources = path.join(root, "Studio.app", "Contents", "Resources");
  const modules = path.join(resources, "app.asar.unpacked", "node_modules");
  owner = path.join(modules, "@sapiom", "opencode");
  runtime = path.join(modules, "opencode-ai");
  binary = path.join(runtime, "bin", "opencode.exe");
  source = path.join(root, "installed-source");
  await fs.mkdir(path.join(owner, "dist"), { recursive: true });
  await fs.mkdir(path.join(runtime, "bin"), { recursive: true });
  await fs.writeFile(source, "verified raw binary");
  await fs.link(source, binary);
  await fs.writeFile(path.join(owner, "package.json"), JSON.stringify({
    name: "@sapiom/opencode", type: "module",
    sapiomNativeRuntime: { version: "owned", sourceCommit: "source" },
  }));
  await fs.writeFile(path.join(runtime, "package.json"), JSON.stringify({ name: "opencode-ai" }));
  // Runtime identity validation has its own native/unit coverage. This fixture
  // proves the pack hook calls that boundary before signing and handles copies.
  await fs.writeFile(path.join(owner, "dist", "runtime-identity.js"), `
    import {readFile} from 'node:fs/promises';
    import {join} from 'node:path';
    export async function readRuntimePin() { return {
      pluginVersion:'upstream', owned:{'opencode-darwin-arm64':'${hash("verified raw binary")}'}
    }; }
    export async function resolveRuntimeCommand(pin, directory) {
      const executable = join(directory,'bin','opencode.exe');
      if (await readFile(executable,'utf8') !== 'verified raw binary') throw Error('unverified bytes');
      return {executable};
    }
  `);
  calls = [];
  context = { electronPlatformName: "darwin", appOutDir: root, packager: {
    appInfo: { productFilename: "Studio" }, platformSpecificBuildOptions: { signIgnore: "existing-rule" },
  } };
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const signer = async () => ({ identity: "fixture-cert", keychainFile: "/private/fixture.keychain" });
async function sign(command, args, options) {
  calls.push({ command, args, options });
  if (args.includes("--sign")) await fs.writeFile(args.at(-1), "signed binary bytes");
}
test("verifies, detaches a copied hardlink, signs once and records the sealed identity", async () => {
  await prepare(context, { signing: signer, run: sign });
  assert.equal(await fs.readFile(source, "utf8"), "verified raw binary");
  assert.equal(await fs.readFile(binary, "utf8"), "signed binary bytes");
  const receipt = JSON.parse(await fs.readFile(path.join(resources, "sapiom-opencode-native-identity.json"), "utf8"));
  assert.equal(receipt.originalSha256, hash("verified raw binary"));
  assert.equal(receipt.signedSha256, hash("signed binary bytes"));
  assert.equal(receipt.executable, path.relative(resources, binary).split(path.sep).join("/"));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { command: "/usr/bin/codesign", args: ["--verify", "--strict", binary], options: { windowsHide: true } });
  assert.deepEqual(calls[0].options, { windowsHide: true });
  assert(calls[0].args.includes("--entitlements"));
  assert(calls[0].args.includes("--timestamp"));
  const filters = context.packager.platformSpecificBuildOptions.signIgnore;
  assert.equal(filters[0], "existing-rule");
  const exclusion = new RegExp(filters[1]);
  assert(exclusion.test(binary));
  assert(!exclusion.test(binary + ".other"));
  assert(!exclusion.test(source));
  assert.deepEqual(await fs.readdir(path.dirname(binary)), ["opencode.exe"]);
});
test("leaves unsigned builds with their original pin and no receipt", async () => {
  await prepare(context, { signing: async () => undefined, run: sign });
  assert.equal(calls.length, 0);
  assert.equal(await fs.readFile(binary, "utf8"), "verified raw binary");
  await assert.rejects(fs.access(path.join(resources, "sapiom-opencode-native-identity.json")));
  assert.equal(context.packager.platformSpecificBuildOptions.signIgnore, "existing-rule");
});
test("rejects unverified bytes before signing or excluding anything", async () => {
  await fs.writeFile(binary, "unexpected");
  await assert.rejects(prepare(context, { signing: signer, run: sign }), /unverified/);
  assert.equal(calls.length, 0);
  assert.equal(context.packager.platformSpecificBuildOptions.signIgnore, "existing-rule");
});
test("rejects ambiguous runtime copies", async () => {
  const duplicate = path.join(runtime, "node_modules", "opencode-ai");
  await fs.mkdir(duplicate, { recursive: true });
  await fs.writeFile(path.join(duplicate, "package.json"), JSON.stringify({ name: "opencode-ai" }));
  await assert.rejects(prepare(context, { signing: signer, run: sign }), /Expected one copied/);
  assert.equal(calls.length, 0);
});
test("a signing failure creates no trusted receipt or exclusion", async () => {
  await assert.rejects(prepare(context, { signing: signer, run: async () => { throw Error("sign failed"); } }), /sign failed/);
  await assert.rejects(fs.access(path.join(resources, "sapiom-opencode-native-identity.json")));
  assert.equal(await fs.readFile(source, "utf8"), "verified raw binary");
  assert.equal(context.packager.platformSpecificBuildOptions.signIgnore, "existing-rule");
});
test("afterSign verifies the containing seal without changing the native receipt", async () => {
  await prepare(context, { signing: signer, run: sign });
  const receiptPath = path.join(resources, "sapiom-opencode-native-identity.json");
  const original = await fs.readFile(receiptPath);
  const outer = [];
  await require("./opencode-after-sign.cjs")(context, async (...args) => { outer.push(args); });
  assert.deepEqual(outer, [["/usr/bin/codesign", ["--verify", "--deep", "--strict", path.join(root, "Studio.app")], { windowsHide: true }]]);
  assert.deepEqual(await fs.readFile(receiptPath), original);
});
test("afterSign rejects native re-signing or changes after receipt creation", async () => {
  await prepare(context, { signing: signer, run: sign });
  await fs.writeFile(binary, "signed again");
  await assert.rejects(require("./opencode-after-sign.cjs")(context), /Outer signing changed/);
});
