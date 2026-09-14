import assert from "node:assert/strict";
import { test } from "node:test";
import { selectedArtifact } from "./install-selection.mjs";

// The verified Windows x64 regular and baseline builds contain identical bytes.
const hash = "a".repeat(64);
const names = ["opencode-windows-x64", "opencode-windows-x64-baseline", "opencode-windows-arm64"];
const artifacts = Object.fromEntries(names.map((name) => [name, {
  artifact: `${name}.tgz`, binarySha256: hash,
}]));
for (const name of names.slice(0, 2)) {
  test(`identifies downloaded ${name} despite an equal binary hash`, () => {
    assert.equal(selectedArtifact(artifacts, [`/${name}.tgz`], hash, "win32", "x64"), name);
  });
}
test("rejects a different target, mismatched bytes, extra downloads and unknown archives", () => {
  for (const [requests, bytes] of [
    [[`/${names[2]}.tgz`], hash],
    [[`/${names[0]}.tgz`], "b".repeat(64)],
    [names.slice(0, 2).map((name) => `/${name}.tgz`), hash],
    [["/unknown.tgz"], hash],
    [[], hash],
  ]) assert.throws(() => selectedArtifact(artifacts, requests, bytes, "win32", "x64"));
});
