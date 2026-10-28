import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.npmjs.org";

// Same selection as `changeset publish`: every non-private workspace package.
export function publicPackages(root) {
  const packagesDir = path.join(root, "packages");
  const found = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(
        readFileSync(
          path.join(packagesDir, entry.name, "package.json"),
          "utf8",
        ),
      );
    } catch {
      continue;
    }
    if (manifest.private === true || !manifest.name || !manifest.version) {
      continue;
    }
    found.push({ name: manifest.name, version: manifest.version });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

// Any answer other than "the version exists" counts as pending: a registry
// hiccup must ask a reviewer, never silently skip a release.
export async function pendingPackages({ root, fetchImpl = fetch, warn }) {
  const pending = [];
  for (const pkg of publicPackages(root)) {
    const url = `${REGISTRY}/${pkg.name.replace("/", "%2f")}`;
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/vnd.npm.install-v1+json" },
      });
      if (response.status === 404) {
        pending.push(pkg);
        continue;
      }
      if (!response.ok) {
        warn?.(`${pkg.name}: registry answered HTTP ${response.status}`);
        pending.push(pkg);
        continue;
      }
      const packument = await response.json();
      if (!packument?.versions?.[pkg.version]) pending.push(pkg);
    } catch (error) {
      warn?.(`${pkg.name}: registry lookup failed (${error.message})`);
      pending.push(pkg);
    }
  }
  return pending;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pending = await pendingPackages({
    root,
    warn: (message) =>
      console.log(`::warning::${message}; treating it as pending.`),
  });
  if (pending.length === 0) {
    console.log("Every public package version is already on npm.");
  } else {
    console.log("Versions not yet on npm:");
    for (const pkg of pending) console.log(`  ${pkg.name}@${pkg.version}`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `pending=${pending.length > 0}\n`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
