/**
 * Unit tests for the entry-input-contract warning (SAP-2227). The entry step's
 * `inputSchema` is the agent's public API (dashboard Run form, trigger snippet,
 * engine validation) — `check` warns, but does not fail, when it is undeclared,
 * so an opaque agent stays legal and the command exits 0. Living in `check()`
 * (not the CLI) means the sapiom_dev_agents_check MCP tool and the dashboard
 * canvas inherit the warning too.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  entryInputSchemaWarning,
  runTypecheck,
  type EntryContractManifest,
} from "./check";

describe("entryInputSchemaWarning", () => {
  it("warns and names the entry step when it declares no inputSchema", () => {
    const manifest: EntryContractManifest = {
      entry: "start",
      steps: {
        start: { inputSchema: null },
        finish: { inputSchema: null },
      },
    };

    const warning = entryInputSchemaWarning(manifest);

    expect(warning).not.toBeNull();
    // Names the offending step so the author knows exactly where to add the schema.
    expect(warning).toContain("entry step 'start'");
    // Frames it as the public contract, not an internal detail.
    expect(warning).toContain("public input contract");
  });

  it("is silent when the entry step declares an inputSchema", () => {
    const manifest: EntryContractManifest = {
      entry: "start",
      // A non-null inputSchema means the contract is published — no warning.
      steps: { start: { inputSchema: { type: "object" } } },
    };

    expect(entryInputSchemaWarning(manifest)).toBeNull();
  });

  it("only inspects the entry step, not other undeclared steps", () => {
    const manifest: EntryContractManifest = {
      entry: "start",
      steps: {
        start: { inputSchema: { type: "object" } },
        // A downstream step without a schema is fine — it is not the public contract.
        finish: { inputSchema: null },
      },
    };

    expect(entryInputSchemaWarning(manifest)).toBeNull();
  });

  it("does not warn when the entry step is missing from the steps map", () => {
    // A malformed manifest is the graph validator's concern, not this warning's.
    const manifest: EntryContractManifest = { entry: "ghost", steps: {} };

    expect(entryInputSchemaWarning(manifest)).toBeNull();
  });
});

describe("check source directory", () => {
  it("runs the project compiler when sourceDir is relative", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sapiom-check-relative-"));
    try {
      const binDir = path.join(dir, "node_modules", ".bin");
      mkdirSync(binDir, { recursive: true });
      const tsc = path.join(binDir, "tsc");
      writeFileSync(tsc, "#!/bin/sh\nexit 0\n");
      chmodSync(tsc, 0o755);
      // Before source-directory normalization, execFile resolved this tsc path
      // beneath cwd a second time and raised TYPECHECK_FAILED instead.
      expect(runTypecheck(path.relative(process.cwd(), dir))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
