/**
 * `pnpm run console:build`: bundle the Console server, its page and the `_shared` code into one
 * `dist/server.mjs`, so the App Link bundle is a single file that needs no install at wake.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { FLEET_ID } from "../../_shared/fleet-id";
import { assertFleetIdSynced } from "../../scripts/fleet-id";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT_FILE = path.join(HERE, "dist", "server.mjs");

export async function buildConsole(): Promise<string> {
  // The bundle inlines the generated fleet id; a stale one would publish to the wrong fleet.
  assertFleetIdSynced(FLEET_ID);
  await build({
    entryPoints: [path.join(HERE, "server.ts")],
    outfile: OUT_FILE,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    loader: { ".html": "text" },
    // pg-mem is only reached by local traces and unit tests (a lazy import in db.ts), never here.
    external: ["pg-mem"],
    // CommonJS dependencies call `require` for node builtins; an ESM bundle has none of its own.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    legalComments: "none",
    logLevel: "warning",
  });
  return OUT_FILE;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  buildConsole().then(
    (out) => console.log(`built ${path.relative(process.cwd(), out)}`),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
