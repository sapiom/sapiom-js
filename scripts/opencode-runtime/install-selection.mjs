import assert from "node:assert/strict";

export function selectedArtifact(artifacts, requests, hash, platform, arch) {
  assert.equal(requests.length, 1, "Install must fetch only its selected archive");
  const prefix = `opencode-${platform === "win32" ? "windows" : platform}-${arch}`;
  const matches = Object.entries(artifacts).filter(([name, item]) =>
    (name === prefix || name.startsWith(`${prefix}-`)) &&
    `/${item.artifact}` === requests[0] && item.binarySha256 === hash,
  );
  assert.equal(matches.length, 1, "Requested archive and installed bytes must identify one target");
  return matches[0][0];
}
