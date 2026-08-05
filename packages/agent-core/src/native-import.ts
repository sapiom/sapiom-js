import { pathToFileURL } from "node:url";

// TypeScript rewrites `import(specifier)` to `require(specifier)` in the CJS
// build. `require()` cannot load the ESM bundles produced by esbuild, so keep
// this import native at runtime for both the CJS and ESM package outputs.
const nativeDynamicImport = new Function(
  "specifier",
  "return import(specifier)",
) as (specifier: string) => Promise<Record<string, unknown>>;

/** Import an ESM file without reusing Node's module cache. */
export function importFreshModule(
  filePath: string,
): Promise<Record<string, unknown>> {
  const url = pathToFileURL(filePath);
  url.searchParams.set("t", `${Date.now()}`);
  return nativeDynamicImport(url.href);
}
