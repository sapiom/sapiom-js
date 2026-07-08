import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { HARNESS_PATHS } from "../shared/types.js";
import { expandHome } from "./paths.js";

/**
 * Stable anonymous install id, used to tag every analytics event
 * (`AnalyticsEvent.machineId`) regardless of which Sapiom user is signed in.
 * Created once on first run and reused forever after.
 */
export async function getOrCreateMachineId(): Promise<string> {
  const filePath = expandHome(HARNESS_PATHS.machineId);

  try {
    const existing = (await fs.readFile(filePath, "utf-8")).trim();
    if (existing) return existing;
  } catch {
    // No file yet — fall through and create one.
  }

  const id = crypto.randomUUID();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, id + "\n");
  return id;
}
