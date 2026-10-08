/**
 * Resolve the fleet id (fleet.local.json over fleet.json) and write it to
 * `_shared/fleet-id.generated.ts`, the file deployed agents and the Console bundle.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fleet from "../fleet.json";
import { assertFleetId, fleetTitle } from "../_shared/fleet-id";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LOCAL_FILE = path.join(ROOT, "fleet.local.json");
const GENERATED_FILE = path.join(ROOT, "_shared", "fleet-id.generated.ts");

/** fleet.local.json's `fleetId` when it sets one, else fleet.json's. */
export function resolveFleetId(local?: { fleetId?: unknown }): string {
  return assertFleetId(local?.fleetId ?? fleet.fleetId);
}

/**
 * The fleet's display name: fleet.local.json's `title`, else fleet.json's, else the name derived
 * from the fleet id. It names the Console's App Link and heads its page; the slugs keep the id.
 */
export function resolveFleetTitle(local?: {
  fleetId?: unknown;
  title?: unknown;
}): string {
  const title = local?.title ?? (fleet as { title?: unknown }).title;
  if (title === undefined) return fleetTitle(resolveFleetId(local));
  if (typeof title !== "string" || !title.trim() || title.length > 80)
    throw new Error(
      `title must be a non-empty string of at most 80 characters (got ${JSON.stringify(title)})`,
    );
  return title.trim();
}

export function readLocalFleetFile():
  | { fleetId?: unknown; title?: unknown }
  | undefined {
  return existsSync(LOCAL_FILE)
    ? JSON.parse(readFileSync(LOCAL_FILE, "utf8"))
    : undefined;
}

export function generatedSource(fleetId: string): string {
  return `// Written by \`pnpm run setup\` and \`pnpm run console:build\` from fleet.json's \`fleetId\`, or
// fleet.local.json's when it sets one. Every agent bundle and the Console read it, so a deployed
// step knows its fleet's name. Do not edit by hand.
export const FLEET_ID = ${JSON.stringify(fleetId)};
`;
}

/** Write the generated file when it differs; returns whether it changed. */
export function syncFleetId(): boolean {
  const source = generatedSource(resolveFleetId(readLocalFleetFile()));
  const have = existsSync(GENERATED_FILE)
    ? readFileSync(GENERATED_FILE, "utf8")
    : "";
  if (have === source) return false;
  writeFileSync(GENERATED_FILE, source);
  return true;
}

/**
 * Throw when the generated file is not what fleet.json and fleet.local.json resolve to. A process
 * has already read `FLEET_ID` by the time it could rewrite the file, so the package scripts run
 * `sync-fleet-id.ts` first and the entry points only check.
 */
export function assertFleetIdSynced(loaded: string): void {
  const wanted = resolveFleetId(readLocalFleetFile());
  if (wanted !== loaded)
    throw new Error(
      `_shared/fleet-id.generated.ts holds '${loaded}' but the fleet files say '${wanted}'; ` +
        `run this through its package script (\`pnpm run setup\`, \`pnpm run console:build\`), which syncs it first`,
    );
}
