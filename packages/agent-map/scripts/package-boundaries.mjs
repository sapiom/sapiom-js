import assert from "node:assert/strict";

const forbidden = new Set(["@sapiom/harness", "@sapiom/mcp"]);

/** Inspect pnpm's installed graph, including aliased and optional dependencies. */
export function assertStandaloneDependencies(tree) {
  const pending = [...tree];
  while (pending.length) {
    const node = pending.pop();
    for (const name of [node.name, node.from]) {
      assert(!forbidden.has(name), `Forbidden installed dependency: ${name}`);
    }
    for (const group of [
      "dependencies",
      "optionalDependencies",
      "unsavedDependencies",
    ]) {
      for (const [name, dependency] of Object.entries(node[group] ?? {})) {
        assert(!forbidden.has(name), `Forbidden installed dependency: ${name}`);
        pending.push(dependency);
      }
    }
  }
}

/** Reject Studio/MCP sources in either workspace or installed bundle paths. */
export function assertStandaloneBrowserInputs(inputs) {
  for (const file of inputs) {
    assert(
      !/(?:^|\/)(?:packages|node_modules\/@sapiom)\/(?:harness|mcp)(?:\/|$)/.test(
        file.replace(/\\/g, "/"),
      ),
      `Forbidden browser dependency: ${file}`,
    );
  }
}
