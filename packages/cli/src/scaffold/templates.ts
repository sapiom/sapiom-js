/**
 * Template resolution — the extension seam.
 *
 * Today this resolves a directory bundled in the published package
 * (`templates/<name>`). It is deliberately the ONLY place that knows where
 * templates come from, so future work — a richer set of pre-supplied examples,
 * or fetching a template from a remote manifest / git — slots in here without
 * touching the command's arg-parsing or scaffold logic.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bundled templates sit beside `dist/` at the package root (shipped via `files`). */
const TEMPLATES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');

export const DEFAULT_TEMPLATE = 'default';

export function listTemplates(): string[] {
  if (!existsSync(TEMPLATES_DIR)) return [];
  return readdirSync(TEMPLATES_DIR).filter((name) => statSync(path.join(TEMPLATES_DIR, name)).isDirectory());
}

/** Absolute path to a bundled template directory. Throws on an unknown name. */
export function resolveTemplate(name: string): string {
  const dir = path.join(TEMPLATES_DIR, name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    const available = listTemplates();
    throw new Error(
      `Unknown template '${name}'.` +
        (available.length ? ` Available: ${available.join(', ')}.` : ' No templates are bundled.'),
    );
  }
  return dir;
}
