// Runs in the build checkout, before electron-builder seals the containing app.
const { createHash, randomUUID } = require("node:crypto");
const { createReadStream, constants } = require("node:fs");
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createRequire } = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const run = promisify(execFile);

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function packages(root) {
  const found = { "@sapiom/opencode": [], "opencode-ai": [] };
  const pending = [root];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop();
    if (++visited > 100000) throw new Error("Packaged dependency traversal exceeded its bound");
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      if (entry.isFile() && entry.name === "package.json" &&
          ["opencode", "opencode-ai"].includes(path.basename(directory))) {
        const metadata = JSON.parse(await fs.readFile(file, "utf8"));
        if (Object.hasOwn(found, metadata.name)) found[metadata.name].push(directory);
      }
    }
  }
  for (const paths of Object.values(found))
    if (paths.length !== 1) throw new Error("Expected one copied OpenCode runtime and SDK");
  return { owner: found["@sapiom/opencode"][0], runtime: found["opencode-ai"][0] };
}
async function signing(context) {
  const options = context.packager.platformSpecificBuildOptions;
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const { findIdentity, isSignAllowed } = builderRequire("app-builder-lib/out/codeSign/macCodeSign.js");
  if (!isSignAllowed() || options.identity === null) return undefined;
  if (options.sign) throw new Error("Owned native packaging requires the standard macOS signer");
  const { keychainFile } = await context.packager.codeSigningInfo.value;
  const types = options.type === "development"
    ? ["Mac Developer", "Apple Development"] : ["Developer ID Application"];
  if (options.type === undefined) types.push("Mac Developer");
  for (const type of types) {
    const identity = await findIdentity(type, options.identity, keychainFile);
    if (identity) return { identity: identity.hash || identity.name, keychainFile };
  }
  // The standard signer owns missing-certificate diagnostics and force-sign policy.
  return undefined;
}
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function prepare(context, dependencies = {}) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = await fs.realpath(path.join(app, "Contents", "Resources"));
  const modules = path.join(resources, "app.asar.unpacked", "node_modules");
  if (await fs.realpath(modules) !== modules) throw new Error("Packaged dependencies must remain inside resources");
  const { owner, runtime } = await packages(modules);
  const metadata = JSON.parse(await fs.readFile(path.join(owner, "package.json"), "utf8"));
  if (!metadata.sapiomNativeRuntime) return; // Existing official pin is unchanged.
  const helper = path.join(owner, "dist", "runtime-identity.js");
  if (await fs.realpath(helper) !== helper) throw new Error("Packaged runtime helper must remain inside resources");
  const identity = await import(pathToFileURL(helper).href);
  const pin = await identity.readRuntimePin(path.join(owner, "package.json"));
  const { executable } = await identity.resolveRuntimeCommand(pin, runtime);
  const originalSha256 = await digest(executable);
  const selected = Object.entries(pin.owned).find(([, hash]) => hash === originalSha256);
  if (!selected) throw new Error("Copied native binary is outside the owned pin");
  const signer = await (dependencies.signing ?? signing)(context);
  if (!signer) return; // Unsigned builds keep original artifact bytes and no receipt.
  // Builder/pnpm copies may be hardlinked. Detach only this bundle's executable
  // before codesign mutates it; the installed artifact/cache must keep its pin.
  const temporary = `${executable}.sign-${randomUUID()}`;
  try {
    await fs.copyFile(executable, temporary, constants.COPYFILE_EXCL);
    if (await digest(temporary) !== originalSha256) throw new Error("Native binary changed before signing");
    await fs.rename(temporary, executable);
  } finally {
    await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
  const execute = dependencies.run ?? run;
  const args = ["--force", "--sign", signer.identity, "--options", "runtime", "--timestamp",
    "--entitlements", path.join(__dirname, "../assets/entitlements.mac.plist")];
  if (signer.keychainFile) args.push("--keychain", signer.keychainFile);
  await execute("/usr/bin/codesign", [...args, executable]);
  await execute("/usr/bin/codesign", ["--verify", "--strict", executable]);
  const receipt = {
    schemaVersion: 1, version: metadata.sapiomNativeRuntime.version,
    pluginVersion: pin.pluginVersion, sourceCommit: metadata.sapiomNativeRuntime.sourceCommit,
    platform: selected[0], originalSha256, signedSha256: await digest(executable),
    executable: path.relative(resources, executable).split(path.sep).join("/"),
  };
  await fs.writeFile(path.join(resources, "sapiom-opencode-native-identity.json"),
    JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  const options = context.packager.platformSpecificBuildOptions;
  const previous = options.signIgnore == null ? [] :
    Array.isArray(options.signIgnore) ? options.signIgnore : [options.signIgnore];
  options.signIgnore = [...previous, `^${escaped(executable)}$`];
}

module.exports = prepare;
module.exports.prepare = prepare;
module.exports.digest = digest;
