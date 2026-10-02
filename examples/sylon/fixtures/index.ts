/** Load every fixture: `{ type, description, payload }`, where `payload` is exactly what a run receives. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Fixture {
  file: string;
  type: string;
  description: string;
  payload: Record<string, unknown>;
}

const DIR = path.dirname(fileURLToPath(import.meta.url));

export function loadFixtures(): Fixture[] {
  return ["slack", "issue"].flatMap((sub) =>
    readdirSync(path.join(DIR, sub))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => {
        const raw = JSON.parse(
          readFileSync(path.join(DIR, sub, f), "utf8"),
        ) as Omit<Fixture, "file">;
        return { file: `${sub}/${f}`, ...raw };
      }),
  );
}

export function fixture(file: string): Fixture {
  const found = loadFixtures().find((f) => f.file === file);
  if (!found) throw new Error(`no fixture ${file}`);
  return found;
}
