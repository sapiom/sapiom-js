import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { bundleForDeploy } from './bundle.js';

describe('bundleForDeploy', () => {
  let proj: string;

  beforeEach(() => {
    proj = mkdtempSync(path.join(tmpdir(), 'byo-bundle-'));
    // A shared local util reached by a relative import — must be INLINED.
    mkdirSync(path.join(proj, 'shared'), { recursive: true });
    writeFileSync(path.join(proj, 'shared', 'util.ts'), 'export const greeting = "shared-hi";\n');
    // A fake installed npm dep — must stay EXTERNAL and have its version resolved.
    mkdirSync(path.join(proj, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(
      path.join(proj, 'node_modules', 'left-pad', 'package.json'),
      JSON.stringify({ name: 'left-pad', version: '1.3.0' }),
    );
    writeFileSync(
      path.join(proj, 'index.ts'),
      [
        'import { greeting } from "./shared/util.js";',
        'import leftPad from "left-pad";',
        'export const out = greeting + String(leftPad);',
      ].join('\n') + '\n',
    );
  });

  afterEach(() => rmSync(proj, { recursive: true, force: true }));

  it('inlines relative/shared imports and externalizes npm deps with resolved versions', async () => {
    const { code, dependencies } = await bundleForDeploy(proj);

    // The shared util is inlined — its content is present and the relative import is gone.
    expect(code).toContain('shared-hi');
    expect(code).not.toMatch(/from\s+["']\.\/shared\/util/);

    // The npm dep is kept external (the server install provides it)…
    expect(code).toMatch(/from\s+["']left-pad["']/);
    // …and pinned to the version installed in the author's tree.
    expect(dependencies).toEqual({ 'left-pad': '1.3.0' });
  });

  it('does not list Node built-ins as dependencies', async () => {
    writeFileSync(
      path.join(proj, 'index.ts'),
      ['import { readFileSync } from "node:fs";', 'export const out = typeof readFileSync;'].join('\n') + '\n',
    );
    const { dependencies } = await bundleForDeploy(proj);
    expect(dependencies).toEqual({});
  });
});
