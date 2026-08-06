/**
 * Unit tests for the entry-input-contract warning (SAP-2227). The entry step's
 * `inputSchema` is the agent's public API (dashboard Run form, trigger snippet,
 * engine validation) — `check` warns, but does not fail, when it is undeclared,
 * so an opaque agent stays legal and the command exits 0. Living in `check()`
 * (not the CLI) means the sapiom_dev_agents_check MCP tool and the dashboard
 * canvas inherit the warning too.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  entryInputSchemaWarning,
  runTypecheck,
  type EntryContractManifest,
} from "./check";
import { AgentOperationError } from "./errors";

/**
 * Stand in for the project's TypeScript compiler at the path runTypecheck runs:
 * node_modules/typescript/bin/tsc, invoked as `node <script>`. So it is a JS
 * file (not the sh shim under .bin) — the .bin shim is what broke on Windows,
 * where the extensionless `.bin/tsc` is a POSIX sh script Node cannot exec.
 */
function writeFakeTsc(dir: string, body: string): void {
  const binDir = path.join(dir, "node_modules", "typescript", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, "tsc"), body);
}

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
  it("runs the project compiler when sourceDir is relative", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sapiom-check-relative-"));
    try {
      writeFakeTsc(dir, "process.exit(0);\n");
      // runTypecheck passes the tsc script as an argv element the child Node
      // resolves against cwd; without normalization a relative sourceDir would
      // resolve it beneath cwd a second time and raise TYPECHECK_FAILED instead.
      expect(runTypecheck(path.relative(process.cwd(), dir))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws TYPECHECK_FAILED with the compiler output on type errors", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sapiom-check-typeerr-"));
    try {
      // Mimic tsc: write diagnostics to stdout, exit non-zero.
      writeFakeTsc(
        dir,
        "process.stdout.write('index.ts(1,1): error TS2322\\n');\nprocess.exit(1);\n",
      );
      try {
        runTypecheck(dir);
        throw new Error("expected runTypecheck to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(AgentOperationError);
        const e = err as AgentOperationError;
        expect(e.code).toBe("TYPECHECK_FAILED");
        // The compiler's own output becomes the hint, not the generic fallback.
        expect(e.hint).toContain("error TS2322");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips typecheck when TypeScript is not installed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sapiom-check-nots-"));
    try {
      expect(runTypecheck(dir)).toContain("TypeScript is not installed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
