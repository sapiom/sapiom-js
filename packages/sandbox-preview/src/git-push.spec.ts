import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { pushLocalDir } from './git-push.js';

const git = (gitDir: string, ...args: string[]): string =>
  execFileSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8' });

function write(root: string, rel: string, content: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
}

describe('pushLocalDir', () => {
  let base: string;
  let src: string;
  let bare: string;
  let secret: string;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'sbxprev-gitpush-'));
    src = path.join(base, 'src');
    bare = path.join(base, 'remote.git');
    secret = path.join(base, 'secret.txt');
    mkdirSync(src);
    execFileSync('git', ['init', '-q', '--bare', bare]);
    writeFileSync(secret, 'TOP-SECRET');

    write(src, 'index.js', 'console.log(1)');
    write(src, 'src/app.js', 'export {}');
    write(src, '.env', 'API_KEY=1');
    write(src, '.npmrc', '//registry/:_authToken=x');
    write(src, 'src/.secret', 'nested');
    write(src, '.github/workflow.yml', 'on: push');
    write(src, 'node_modules/x/index.js', 'module.exports = 1');
    write(src, '.gitignore', 'ignored.txt\n');
    write(src, 'ignored.txt', 'ignored');
    symlinkSync(secret, path.join(src, 'link.txt'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('pushes the tree without dotfiles at any depth, node_modules or gitignored files', () => {
    pushLocalDir(src, bare, 'sk_test');

    const files = git(bare, 'ls-tree', '-r', '--name-only', 'main').trim().split('\n').sort();
    expect(files).toEqual(['index.js', 'link.txt', 'src/app.js']);
  });

  it('skips dotfiles even when the project .gitignore re-includes them', () => {
    write(src, '.gitignore', '!.env\n!.npmrc\n!src/.secret\n!.github/\n!node_modules/\n');

    pushLocalDir(src, bare, 'sk_test');

    const files = git(bare, 'ls-tree', '-r', '--name-only', 'main').trim().split('\n').sort();
    expect(files).toEqual(['ignored.txt', 'index.js', 'link.txt', 'src/app.js']);
  });

  it('commits a symlink as a link, never the content it points at', () => {
    pushLocalDir(src, bare, 'sk_test');

    const [meta] = git(bare, 'ls-tree', 'main', 'link.txt').split('\t');
    const [mode, , blob] = meta.split(' ');
    expect(mode).toBe('120000');
    const content = git(bare, 'cat-file', '-p', blob);
    expect(content).toBe(secret);
    expect(content).not.toContain('TOP-SECRET');
  });
});
