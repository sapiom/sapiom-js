/**
 * The analytics suites need built artifacts before test files load: the unit
 * suite imports @sapiom/analytics-core, and the e2e suite runs the BUILT CLI
 * (dist/bin.js) against a mock collector.
 *
 * CI builds before testing, so the common case is a fast rebuild of this
 * package only (keeping dist/bin.js in sync with src for the e2e); a bare
 * `pnpm test` on a fresh clone triggers the full dependency build instead.
 */
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

module.exports = function globalSetup() {
  const packageRoot = __dirname;
  const dependencyArtifacts = [
    path.join('@sapiom', 'analytics-core', 'dist', 'cjs', 'index.js'),
    path.join('@sapiom', 'analytics-core', 'dist', 'esm', 'index.js'),
    path.join('@sapiom', 'agent-core', 'dist', 'esm', 'index.js'),
  ].map((artifact) => path.join(packageRoot, 'node_modules', artifact));

  const dependenciesMissing = dependencyArtifacts.some((artifact) => !existsSync(artifact));
  const filter = dependenciesMissing ? '@sapiom/cli...' : '@sapiom/cli';
  execFileSync('pnpm', ['--filter', filter, 'build'], { cwd: packageRoot, stdio: 'inherit' });
};
