import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";

describe("importFreshModule", () => {
  it("loads an ESM file when agent-core is running from its CJS build", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sapiom-native-import-"));
    const modulePath = path.join(dir, "definition.mjs");
    const helperPath = path.join(dir, "native-import.js");
    writeFileSync(
      modulePath,
      "export const definition = { name: 'loaded' };\n",
    );
    const source = readFileSync(
      path.join(__dirname, "native-import.ts"),
      "utf8",
    );
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText;
    writeFileSync(helperPath, compiled);

    try {
      const output = execFileSync(
        process.execPath,
        [
          "-e",
          "require(process.argv[1]).importFreshModule(process.argv[2]).then((mod) => process.stdout.write(JSON.stringify(mod.definition)))",
          helperPath,
          modulePath,
        ],
        { encoding: "utf8" },
      );
      expect(JSON.parse(output)).toEqual({ name: "loaded" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
