// Read-only: altering resources here would invalidate the containing signature.
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { digest } = require("./opencode-after-pack.cjs");
module.exports = async (context, execute = promisify(execFile)) => {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = path.join(app, "Contents", "Resources");
  const receipt = await fs.readFile(path.join(resources, "sapiom-opencode-native-identity.json"), "utf8")
    .catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!receipt) return;
  const parsed = JSON.parse(receipt);
  const binary = path.resolve(resources, parsed.executable);
  if (!binary.startsWith(resources + path.sep) || await digest(binary) !== parsed.signedSha256)
    throw new Error("Outer signing changed the verified native binary");
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
};
