import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { signedDesktopRuntimeDigest } from "./desktop-runtime-identity.js";

// This compatibility pair is backed by the owned source and native plugin tests.
const version = "1.18.29-sapiom.3328.2";
const pluginVersion = "1.18.29";
const sourceCommit = "16747470f976aca3d362ad730bcd3fe82ecc2c9a";
const artifactURL = `https://github.com/sapiom/sapiom-js/releases/download/opencode-runtime-v${version}/opencode-ai-${version}.tgz`;
const platforms = [
  "darwin-arm64",
  "darwin-x64",
  "darwin-x64-baseline",
  "linux-arm64",
  "linux-arm64-musl",
  "linux-x64",
  "linux-x64-baseline",
  "linux-x64-baseline-musl",
  "linux-x64-musl",
  "windows-arm64",
  "windows-x64",
  "windows-x64-baseline",
].map((platform) => `opencode-${platform}`);
const patches = {
  "disable-nested-instructions.patch":
    "d811776b6041953477293f7803419cff5a763bc1cb66f4c3b357367499471bc9",
  "system-hook-request-identity.patch":
    "8779acc7582ba6474a842ecb8535f01b5fb9b40937afb758da53ea28951b0311",
};
interface RuntimePin {
  readonly pluginVersion: string;
  readonly owned?: Readonly<Record<string, string>>;
}
function check(condition: unknown): asserts condition {
  if (!condition)
    throw new Error(
      "The installed OpenCode runtime does not match its verified pin",
    );
}
function record(value: unknown): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Package metadata is shipped with the SDK; callers cannot select compatibility. */
export async function readRuntimePin(
  ownerPath: string | URL = new URL("../package.json", import.meta.url),
): Promise<RuntimePin> {
  const owner = record(JSON.parse(await readFile(ownerPath, "utf8")));
  const dependencies = record(owner.dependencies);
  const plugin = dependencies["@opencode-ai/plugin"];
  check(typeof plugin === "string" && /^\d+\.\d+\.\d+$/.test(plugin));
  if (owner.sapiomNativeRuntime === undefined) {
    check(dependencies["opencode-ai"] === plugin);
    return { pluginVersion: plugin };
  }
  const pin = record(owner.sapiomNativeRuntime);
  check(
    pin.schemaVersion === 1 &&
      pin.version === version &&
      pin.pluginVersion === pluginVersion &&
      pin.sourceCommit === sourceCommit &&
      plugin === pluginVersion &&
      dependencies["opencode-ai"] === artifactURL,
  );
  const hashes = record(pin.binarySha256);
  check(
    Object.keys(hashes).sort().join("\n") === [...platforms].sort().join("\n"),
  );
  for (const hash of Object.values(hashes))
    check(typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash));
  return {
    pluginVersion: plugin,
    owned: Object.freeze({ ...hashes }) as Record<string, string>,
  };
}

/** Verify the installed bytes before starting the supervisor or native process. */
export async function resolveRuntimeCommand(
  suppliedPin?: RuntimePin,
  directory = dirname(
    createRequire(import.meta.url).resolve("opencode-ai/package.json"),
  ).replace(/([/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2"),
): Promise<{ executable: string }> {
  const pin = suppliedPin ?? (await readRuntimePin());
  const executable = join(directory, "bin", "opencode.exe");
  if (!pin.owned) return { executable };
  const installed = record(
    JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
  );
  check(installed.name === "opencode-ai" && installed.version === version);
  const provenance = record(
    JSON.parse(
      await readFile(join(directory, "native-provenance.json"), "utf8"),
    ),
  );
  const inputs = record(provenance.nativeInputs);
  check(
    provenance.schemaVersion === 1 &&
      inputs.runtimeVersion === version &&
      inputs.pluginVersion === pluginVersion &&
      record(inputs.source).commit === sourceCommit,
  );
  const actualPatches = record(inputs.patches);
  for (const [name, hash] of Object.entries(patches))
    check(actualPatches[name] === hash);
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const prefix = `opencode-${platform}-${process.arch}`;
  const allowed = Object.entries(pin.owned).filter(
    ([name]) => name === prefix || name.startsWith(`${prefix}-`),
  );
  check(allowed.length > 0);
  const signedHash = await signedDesktopRuntimeDigest(executable, allowed, {
    version,
    pluginVersion,
    sourceCommit,
  });
  check((await lstat(executable)).isFile());
  const file = await open(
    executable,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    check(stat.isFile());
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false }))
      hash.update(chunk);
    const actual = hash.digest("hex");
    check(
      signedHash
        ? actual === signedHash
        : allowed.some(([, expected]) => expected === actual),
    );
  } finally {
    await file.close();
  }
  return { executable };
}
