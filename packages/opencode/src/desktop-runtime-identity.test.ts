import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { signedDesktopRuntimeDigest } from "./desktop-runtime-identity.js";

const identity = {
  version: "owned",
  pluginVersion: "upstream",
  sourceCommit: "source",
};
const allowed = [["opencode-darwin-arm64", "a".repeat(64)]] as const;
let root: string, resources: string, binary: string, receiptPath: string;
let context: NonNullable<Parameters<typeof signedDesktopRuntimeDigest>[3]>;
let receipt: Record<string, unknown>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desktop-runtime-"));
  resources = join(root, "Studio.app", "Contents", "Resources");
  const modules = join(resources, "app.asar.unpacked", "node_modules");
  binary = join(modules, "opencode-ai", "bin", "opencode.exe");
  context = {
    platform: "darwin",
    electron: "33.4.11",
    type: "browser",
    resourcesPath: resources,
    execPath: join(root, "Studio.app", "Contents", "MacOS", "Studio"),
    ownerPath: join(modules, "@sapiom", "opencode", "package.json"),
  };
  for (const file of [binary, context.execPath, context.ownerPath]) {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "fixture");
  }
  receiptPath = join(resources, "sapiom-opencode-native-identity.json");
  receipt = {
    schemaVersion: 1,
    ...identity,
    platform: allowed[0][0],
    originalSha256: allowed[0][1],
    signedSha256: "b".repeat(64),
    executable: relative(resources, binary).split("\\").join("/"),
  };
  await writeFile(receiptPath, JSON.stringify(receipt));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const resolve = () =>
  signedDesktopRuntimeDigest(binary, allowed, identity, context);

it("reads only the receipt inside the executing packaged Electron app", async () => {
  expect(await resolve()).toBe("b".repeat(64));
});
it.each([
  "cli",
  "renderer",
  "other-platform",
  "development",
  "external-sdk",
  "external-native",
])("does not select receipt authority for %s", async (kind) => {
  if (kind === "cli") context.electron = undefined;
  if (kind === "renderer") context.type = "renderer";
  if (kind === "other-platform") context.platform = "linux";
  const external = join(root, "external");
  await writeFile(external, "outside");
  if (kind === "development") context.execPath = external;
  if (kind === "external-sdk") context.ownerPath = external;
  if (kind === "external-native") binary = external;
  expect(await resolve()).toBeUndefined();
});
it("keeps raw artifact verification for an unsigned bundle without a receipt", async () => {
  await rm(receiptPath);
  expect(await resolve()).toBeUndefined();
});
it.each([
  "version",
  "pluginVersion",
  "sourceCommit",
  "platform",
  "originalSha256",
  "signedSha256",
  "executable",
  "schemaVersion",
])("rejects a packaged receipt with mismatched %s", async (field) => {
  receipt[field] = "changed";
  await writeFile(receiptPath, JSON.stringify(receipt));
  await expect(resolve()).rejects.toThrow("signing identity");
});
it.each(["null", "{", "x".repeat(8193)])(
  "rejects malformed or oversized receipt data",
  async (data) => {
    await writeFile(receiptPath, data);
    await expect(resolve()).rejects.toThrow();
  },
);
it.skipIf(process.platform === "win32")(
  "rejects a receipt symlink",
  async () => {
    const outside = join(root, "receipt");
    await writeFile(outside, JSON.stringify(receipt));
    await rm(receiptPath);
    await symlink(outside, receiptPath);
    await expect(resolve()).rejects.toThrow("signing identity");
  },
);
