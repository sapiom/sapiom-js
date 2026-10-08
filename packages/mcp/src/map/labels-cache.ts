/**
 * Where Jev label answers are kept between map calls: `<root>/.sapiom/cache/map-labels.json`
 * for a scanned project, memory for a caller's own description (it has no folder).
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CachedAnswer, LabelCache, LabelCacheData } from "./labels.js";

const VERSION = 1;

export function labelCachePath(root: string): string {
  return path.join(root, ".sapiom", "cache", "map-labels.json");
}

function answerRecord(value: unknown): Record<string, CachedAnswer> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, answer]) => {
      const candidate = answer as Partial<CachedAnswer> | null;
      return (
        typeof candidate?.value === "string" && typeof candidate.p === "number"
      );
    }),
  ) as Record<string, CachedAnswer>;
}

export function fileLabelCache(root: string): LabelCache {
  const file = labelCachePath(root);
  return {
    async read() {
      let parsed: { version?: unknown; answers?: unknown; shown?: unknown };
      try {
        parsed = JSON.parse(await readFile(file, "utf8"));
      } catch {
        return { answers: {}, shown: {} }; // missing or unreadable: start empty
      }
      if (parsed?.version !== VERSION) return { answers: {}, shown: {} };
      return {
        answers: answerRecord(parsed.answers),
        shown: answerRecord(parsed.shown),
      };
    },
    async write(data) {
      const dir = path.dirname(file);
      await mkdir(dir, { recursive: true });
      // The cache is local state: ignore it from inside, so the project's own .gitignore stays untouched.
      await writeFile(path.join(dir, ".gitignore"), "*\n", {
        flag: "wx",
      }).catch(() => undefined);
      // Unique per write: two map calls on one project must never share a temp file.
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(
        temp,
        `${JSON.stringify({ version: VERSION, ...data }, null, 1)}\n`,
      );
      await rename(temp, file);
    },
  };
}

/**
 * Keeps answers only. Described maps share one server-wide cache and have no project identity,
 * so a label shown for slug `a` in one map must never carry over to an unrelated map's `a`.
 */
export function memoryLabelCache(): LabelCache {
  let answers: LabelCacheData["answers"] = {};
  return {
    async read() {
      return { answers: { ...answers }, shown: {} };
    },
    async write(next) {
      answers = { ...next.answers };
    },
  };
}
