import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface DesktopProcess {
  platform: string;
  electron?: string;
  type?: string;
  resourcesPath?: string;
  execPath: string;
  ownerPath: string;
}
const unpack = (path: string) =>
  path.replace(/([/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2");
function currentProcess(): DesktopProcess {
  const desktop = process as NodeJS.Process & {
    type?: string;
    resourcesPath?: string;
  };
  return {
    platform: process.platform,
    electron: process.versions.electron,
    type: desktop.type,
    resourcesPath: desktop.resourcesPath,
    execPath: process.execPath,
    ownerPath: unpack(
      fileURLToPath(new URL("../package.json", import.meta.url)),
    ),
  };
}
const inside = (root: string, path: string) => {
  const child = relative(root, path);
  return (
    child !== "" &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !child.startsWith(sep)
  );
};
function check(value: unknown): asserts value {
  if (!value)
    throw new Error("The packaged OpenCode signing identity is invalid");
}

/** A receipt is part of the trusted installed app, like its SDK-owned pin.
 * It is sealed by outer app signing after the native binary is signed once.
 * CLI Node, development Electron and arbitrary nearby receipts cannot select it. */
export async function signedDesktopRuntimeDigest(
  executable: string,
  allowed: readonly (readonly [string, string])[],
  identity: { version: string; pluginVersion: string; sourceCommit: string },
  context = currentProcess(),
): Promise<string | undefined> {
  if (
    context.platform !== "darwin" ||
    !context.electron ||
    context.type !== "browser" ||
    !context.resourcesPath
  )
    return undefined;
  const resources = await realpath(context.resourcesPath);
  const app = dirname(dirname(resources));
  if (!app.endsWith(".app") || resources !== join(app, "Contents", "Resources"))
    return undefined;
  if (
    dirname(await realpath(context.execPath)) !== join(app, "Contents", "MacOS")
  )
    return undefined;
  const modules = join(resources, "app.asar.unpacked", "node_modules");
  const owner = await realpath(context.ownerPath);
  const binary = await realpath(executable);
  // Electron's development executable must not confer trust on an external SDK.
  if (!inside(modules, owner) || !inside(modules, binary)) return undefined;
  const receiptPath = join(resources, "sapiom-opencode-native-identity.json");
  const stat = await lstat(receiptPath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (!stat) return undefined; // Unsigned bundles retain raw artifact verification.
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8192);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<
    string,
    unknown
  >;
  check(
    receipt &&
      receipt.schemaVersion === 1 &&
      receipt.version === identity.version &&
      receipt.pluginVersion === identity.pluginVersion &&
      receipt.sourceCommit === identity.sourceCommit &&
      receipt.executable === relative(resources, binary).split(sep).join("/") &&
      allowed.some(
        ([platform, hash]) =>
          receipt.platform === platform && receipt.originalSha256 === hash,
      ) &&
      typeof receipt.signedSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(receipt.signedSha256),
  );
  return receipt.signedSha256;
}
