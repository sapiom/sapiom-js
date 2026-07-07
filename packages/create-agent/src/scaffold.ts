/**
 * Copy a template directory into the target, applying placeholder substitution
 * and the dotfile-rename convention.
 *
 * Why `_gitignore` → `.gitignore`: npm strips/renames a literal `.gitignore`
 * inside a published package, so templates store it as `_gitignore` and we
 * restore the dot on scaffold. Same trick applies to any other dotfile.
 */
import { cpSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ScaffoldOptions {
  templateDir: string;
  targetDir: string;
  /** Literal `__TOKEN__` → value substitutions applied to every text file. */
  replacements: Record<string, string>;
}

const DOTFILE_PREFIX = '_';
const DOTFILE_NAMES = new Set(['_gitignore', '_npmrc']);

export function scaffold({ templateDir, targetDir, replacements }: ScaffoldOptions): void {
  cpSync(templateDir, targetDir, { recursive: true });
  walk(targetDir, (file) => {
    const base = path.basename(file);

    // Restore dotfiles: _gitignore → .gitignore
    if (DOTFILE_NAMES.has(base)) {
      const dotted = path.join(path.dirname(file), '.' + base.slice(DOTFILE_PREFIX.length));
      renameSync(file, dotted);
      applyReplacements(dotted, replacements);
      return;
    }

    applyReplacements(file, replacements);
  });
}

function applyReplacements(file: string, replacements: Record<string, string>): void {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return; // unreadable / binary — leave as-is
  }
  let changed = false;
  for (const [token, value] of Object.entries(replacements)) {
    if (content.includes(token)) {
      content = content.split(token).join(value);
      changed = true;
    }
  }
  if (changed) writeFileSync(file, content);
}

function walk(dir: string, onFile: (file: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}
