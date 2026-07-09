#!/usr/bin/env node
/**
 * Demo prep: seeds a directory the harness opens beautifully on first run.
 *
 *   pnpm --filter @sapiom/harness seed-example [dir] [--install]
 *   (default dir: ./harness-example; --install runs `npm install` in the
 *   scaffolded project afterward, to pre-warm node_modules ahead of a demo)
 *
 * Thin wrapper over the shared seeding module (src/core/example-seed.ts) —
 * the same code path the server's POST /api/sample-project (welcome panel's
 * "Run the sample project") uses, so the demo seed and the in-app sample
 * can never drift from each other. This wrapper always seeds with
 * `force: true` (wipe and regenerate), the historical behavior of this
 * script; the in-app path reuses an existing copy instead.
 *
 * Requires the harness package itself to already be built (`pnpm build` or
 * `build:server`) — this imports from dist/, the same way it already needs
 * @sapiom/agent-core's dist built.
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { SAMPLE_PROJECT_NAME, seedExampleProject } from "../dist/core/example-seed.js";

function parseArgs(argv) {
  let dir;
  let install = false;
  for (const arg of argv) {
    if (arg === "--install") install = true;
    else if (!arg.startsWith("--")) dir = arg;
  }
  return { dir: dir ?? "./harness-example", install };
}

/** Best-effort `npm install` in the scaffolded project — used by --install to pre-warm node_modules for demo prep. */
function npmInstall(projectDir) {
  console.log(`Running npm install in ${projectDir} …`);
  const result = spawnSync("npm", ["install"], { cwd: projectDir, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`npm install failed (exit ${result.status}) in ${projectDir}`);
  }
}

async function main() {
  const { dir, install } = parseArgs(process.argv.slice(2));

  const { root, projectDir, gitInitialized } = await seedExampleProject({
    targetRoot: path.resolve(dir),
    force: true,
  });

  if (install) npmInstall(projectDir);

  const cwdRelative = path.relative(process.cwd(), root);
  const displayRoot = cwdRelative && !cwdRelative.startsWith("..") ? cwdRelative : root;

  console.log(`\nSeeded demo directory: ${root}\n`);
  console.log(
    `  ${SAMPLE_PROJECT_NAME}/  (sapiom.json + ${SAMPLE_PROJECT_NAME} agent, git ${
      gitInitialized ? "initialized" : "NOT initialized — git unavailable"
    }${install ? ", dependencies installed" : ""})`,
  );
  console.log(`  .sapiom/canvas/index.html  (opening canvas visualization)`);
  console.log("");
  console.log(`Next: cd ${displayRoot} && sapiom-harness`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
