/**
 * Load every fixture under `fixtures/<dir>/`: `{ type, description, payload }`, where `payload` is
 * exactly what a run receives. `type` is an event type, or `schedule_cron` for a cron fire's
 * stored input. A JSON file without a `type` (such as `intake/jev.json`, canned Jev answers) is
 * test data, not a fixture, and is skipped.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Fixture {
  /** Path relative to `fixtures/`, e.g. `slack/message-created.channel.json`. */
  file: string;
  type: string;
  description: string;
  payload: Record<string, unknown>;
}

const DIR = path.dirname(fileURLToPath(import.meta.url));

export function loadFixtures(): Fixture[] {
  return readdirSync(DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .flatMap((sub) =>
      readdirSync(path.join(DIR, sub))
        .filter((f) => f.endsWith(".json"))
        .sort()
        .flatMap((f) => {
          const raw = JSON.parse(
            readFileSync(path.join(DIR, sub, f), "utf8"),
          ) as Partial<Omit<Fixture, "file">>;
          if (typeof raw.type !== "string" || !raw.payload) return [];
          return [{ file: `${sub}/${f}`, ...(raw as Omit<Fixture, "file">) }];
        }),
    );
}

export function fixture(file: string): Fixture {
  const found = loadFixtures().find((f) => f.file === file);
  if (!found) throw new Error(`no fixture ${file}`);
  return found;
}
