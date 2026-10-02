import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MIGRATIONS } from "./index";

const DIR = path.dirname(fileURLToPath(import.meta.url));

describe("migrations", () => {
  it("mirrors every .sql file byte for byte", () => {
    for (const m of MIGRATIONS) {
      expect(m.sql).toBe(readFileSync(path.join(DIR, `${m.id}.sql`), "utf8"));
    }
  });
});
