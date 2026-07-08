/**
 * Unit tests for `sapiom.json` helpers, focused on the merge semantics of
 * `writeConfig` (SAP-1357): a later `link` must not clobber the fork provenance
 * a `clone` wrote.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CONFIG_FILE, readConfig, requireConfig, writeConfig } from './config';

function makeTmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'sapiom-config-test-'));
}

describe('writeConfig / readConfig', () => {
  it('merges over an existing config instead of replacing it', () => {
    const dir = makeTmp();
    try {
      // clone writes provenance...
      writeConfig(dir, {
        repoFullName: 'Sapiom-Platform/sapiom-fork-abc',
        defaultBranch: 'main',
        forkId: 'fork-1',
        templateId: 'web-research-digest',
      });
      // ...then link writes the resolved definition.
      writeConfig(dir, { definitionId: 'def-1', name: 'web-research-digest' });

      const cfg = readConfig(dir);
      expect(cfg).toEqual({
        repoFullName: 'Sapiom-Platform/sapiom-fork-abc',
        defaultBranch: 'main',
        forkId: 'fork-1',
        templateId: 'web-research-digest',
        definitionId: 'def-1',
        name: 'web-research-digest',
      });

      const onDisk = JSON.parse(readFileSync(path.join(dir, CONFIG_FILE), 'utf8'));
      expect(onDisk.definitionId).toBe('def-1');
      expect(onDisk.forkId).toBe('fork-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requireConfig still throws NOT_LINKED when only provenance is present', () => {
    const dir = makeTmp();
    try {
      writeConfig(dir, { repoFullName: 'owner/repo', defaultBranch: 'main', forkId: 'f' });
      expect(() => requireConfig(dir)).toThrow(expect.objectContaining({ code: 'NOT_LINKED' }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
