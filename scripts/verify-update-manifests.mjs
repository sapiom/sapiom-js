import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function walk(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

export function verifyUpdateManifests(root, channel) {
  const files = walk(resolve(root));
  const assetNames = new Set(files.map((path) => basename(path)));
  const manifests = files.filter((path) => {
    const name = basename(path);
    return name.startsWith(channel) && name.endsWith(".yml");
  });
  const references = manifests.flatMap((manifest) =>
    [
      ...readFileSync(manifest, "utf8").matchAll(/^\s*-\s+url:\s+(.+?)\s*$/gm),
    ].map((match) => ({
      manifest: basename(manifest),
      artifact: match[1].replace(/^(["'])(.*)\1$/, "$2").replace(/\r$/, ""),
    })),
  );

  if (references.length === 0) {
    throw new Error(
      `No update artifact URLs were found in the ${channel} manifests.`,
    );
  }

  const missing = references.filter(
    ({ artifact }) => !assetNames.has(artifact),
  );
  if (missing.length > 0) {
    throw new Error(
      missing
        .map(
          ({ manifest, artifact }) =>
            `${manifest} references '${artifact}', but no exact release asset has that filename. Installed apps would receive a 404.`,
        )
        .join("\n"),
    );
  }

  return { manifests: manifests.length, references: references.length };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [, , root = "dist-artifacts", channel = "latest"] = process.argv;
  const result = verifyUpdateManifests(root, channel);
  console.log(
    `Verified ${result.references} artifact reference(s) across ${result.manifests} update manifest(s).`,
  );
}
