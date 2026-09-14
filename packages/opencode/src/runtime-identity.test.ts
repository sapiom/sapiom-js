import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readRuntimePin, resolveRuntimeCommand } from "./runtime-identity.js";
import * as desktop from "./desktop-runtime-identity.js";

const version = "1.18.29-sapiom.3328.2";
const pluginVersion = "1.18.29";
const inputs = JSON.parse(
  await readFile(new URL("../native-runtime.json", import.meta.url), "utf8"),
);
const artifactURL = `https://github.com/sapiom/sapiom-js/releases/download/opencode-runtime-v${version}/opencode-ai-${version}.tgz`;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
let root: string;
let ownerPath: string;
let directory: string;
let executable: string;
const binaryName = `opencode-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
function owner() {
  return {
    dependencies: {
      "opencode-ai": artifactURL,
      "@opencode-ai/plugin": pluginVersion,
    },
    sapiomNativeRuntime: {
      schemaVersion: 1,
      version,
      pluginVersion,
      sourceCommit: inputs.source.commit,
      binarySha256: Object.fromEntries(
        inputs.platforms.map((name: string) => [name, hash(name)]),
      ),
    },
  };
}
async function json(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value));
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "runtime-identity-"));
  ownerPath = join(root, "owner.json");
  directory = join(root, "runtime");
  executable = join(directory, "bin", "opencode.exe");
  await mkdir(join(directory, "bin"), { recursive: true });
  await json(ownerPath, owner());
  await json(join(directory, "package.json"), { name: "opencode-ai", version });
  await json(join(directory, "native-provenance.json"), {
    schemaVersion: 1,
    nativeInputs: inputs,
  });
  // These small fixture bytes are never executed; actual native coverage is separate.
  await writeFile(executable, binaryName);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it("requires the signed hash when the packaged-app boundary supplies a receipt", async () => {
  vi.spyOn(desktop, "signedDesktopRuntimeDigest").mockResolvedValue(
    hash("signed bytes"),
  );
  const pin = await readRuntimePin(ownerPath);
  // Even the original valid artifact cannot substitute for the receipt's bytes.
  await expect(resolveRuntimeCommand(pin, directory)).rejects.toThrow(
    "verified pin",
  );
  await writeFile(executable, "signed bytes");
  expect(await resolveRuntimeCommand(pin, directory)).toEqual({ executable });
  await writeFile(executable, "changed after signing");
  await expect(resolveRuntimeCommand(pin, directory)).rejects.toThrow(
    "verified pin",
  );
});

it("retains the exact upstream plugin version for the verified owned artifact", async () => {
  const pin = await readRuntimePin(ownerPath);
  expect(pin.pluginVersion).toBe(pluginVersion);
  expect(await resolveRuntimeCommand(pin, directory)).toEqual({ executable });
});
it("preserves an unmodified official runtime and exact plugin pairing", async () => {
  await json(ownerPath, {
    dependencies: {
      "opencode-ai": pluginVersion,
      "@opencode-ai/plugin": pluginVersion,
    },
  });
  const pin = await readRuntimePin(ownerPath);
  expect(pin).toEqual({ pluginVersion });
  expect(await resolveRuntimeCommand(pin, directory)).toEqual({ executable });
});
it.each([
  [
    "mismatched plugin",
    (value: ReturnType<typeof owner>) => {
      value.dependencies["@opencode-ai/plugin"] = "1.18.30";
    },
  ],
  [
    "missing compatibility",
    (value: ReturnType<typeof owner>) => {
      delete (value as Partial<ReturnType<typeof owner>>).sapiomNativeRuntime;
    },
  ],
  [
    "floating artifact",
    (value: ReturnType<typeof owner>) => {
      value.dependencies["opencode-ai"] = "latest";
    },
  ],
  [
    "different release URL",
    (value: ReturnType<typeof owner>) => {
      value.dependencies["opencode-ai"] = artifactURL.replace(
        "sapiom/sapiom-js",
        "other/runtime",
      );
    },
  ],
  [
    "unverified source",
    (value: ReturnType<typeof owner>) => {
      value.sapiomNativeRuntime.sourceCommit = "0".repeat(40);
    },
  ],
  [
    "different compatibility version",
    (value: ReturnType<typeof owner>) => {
      value.sapiomNativeRuntime.version = "1.18.29-sapiom.3328.3";
    },
  ],
  [
    "missing platform",
    (value: ReturnType<typeof owner>) => {
      delete value.sapiomNativeRuntime.binarySha256[binaryName];
    },
  ],
  [
    "extra platform",
    (value: ReturnType<typeof owner>) => {
      value.sapiomNativeRuntime.binarySha256.other = hash("other");
    },
  ],
  [
    "invalid digest",
    (value: ReturnType<typeof owner>) => {
      value.sapiomNativeRuntime.binarySha256[binaryName] = "not-a-hash";
    },
  ],
] as const)(
  "rejects %s before resolving the native command",
  async (_name, change) => {
    const value = owner();
    change(value);
    await json(ownerPath, value);
    await expect(readRuntimePin(ownerPath)).rejects.toThrow("verified pin");
  },
);
it.each([
  "#!/bin/sh\nexit 1",
  "tampered binary",
  "opencode-other-architecture",
])("rejects installed bytes outside the pin: %s", async (bytes) => {
  await writeFile(executable, bytes);
  await expect(
    resolveRuntimeCommand(await readRuntimePin(ownerPath), directory),
  ).rejects.toThrow("verified pin");
});
it("allows the verified baseline binary selected by the owned installer", async () => {
  if (process.arch !== "x64") return;
  await writeFile(executable, `${binaryName}-baseline`);
  expect(
    await resolveRuntimeCommand(await readRuntimePin(ownerPath), directory),
  ).toEqual({ executable });
});
it("rejects a verified binary for another platform", async () => {
  const other = inputs.platforms.find(
    (name: string) => !name.startsWith(binaryName),
  );
  await writeFile(executable, other);
  await expect(
    resolveRuntimeCommand(await readRuntimePin(ownerPath), directory),
  ).rejects.toThrow("verified pin");
});
it.each(["version", "name"])(
  "rejects different installed package %s",
  async (field) => {
    await json(join(directory, "package.json"), {
      name: "opencode-ai",
      version,
      [field]: "unexpected",
    });
    await expect(
      resolveRuntimeCommand(await readRuntimePin(ownerPath), directory),
    ).rejects.toThrow("verified pin");
  },
);
it.each(["source", "patch", "plugin"])(
  "rejects mismatched installed %s provenance",
  async (field) => {
    const changed = structuredClone(inputs);
    if (field === "source") changed.source.commit = "0".repeat(40);
    if (field === "patch")
      changed.patches["system-hook-request-identity.patch"] = "0".repeat(64);
    if (field === "plugin") changed.pluginVersion = "1.18.30";
    await json(join(directory, "native-provenance.json"), {
      schemaVersion: 1,
      nativeInputs: changed,
    });
    await expect(
      resolveRuntimeCommand(await readRuntimePin(ownerPath), directory),
    ).rejects.toThrow("verified pin");
  },
);
it.skipIf(process.platform === "win32")(
  "rejects a launcher symlink even when its target has verified bytes",
  async () => {
    const target = join(root, "outside");
    await writeFile(target, binaryName);
    await rm(executable);
    await symlink(target, executable);
    await expect(
      resolveRuntimeCommand(await readRuntimePin(ownerPath), directory),
    ).rejects.toThrow("verified pin");
  },
);
it("rejects a missing installed launcher", async () => {
  await rm(executable);
  await expect(
    resolveRuntimeCommand(await readRuntimePin(ownerPath), directory),
  ).rejects.toThrow();
});
