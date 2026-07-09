/**
 * previewSandbox — the client-side sandbox-preview flow.
 *
 * Reads the `sapiom.json` `type: "sandbox"` resource, ensures a running sandbox,
 * uploads the local source, and calls the server-side `previews` deploy op. The
 * deploy recipe (build/start/expose/poll) lives server-side; this layer only
 * provisions + uploads + triggers. Pure of process.env — the caller (CLI/MCP)
 * supplies `dir`, `apiKey`, and any host override.
 */
import path from 'node:path';

import { createClient } from '@sapiom/tools';
import type { Sapiom } from '@sapiom/tools';

import { getSandbox } from './config.js';
import { PreviewOperationError } from './errors.js';
import { pushLocalDir } from './git-push.js';
import type { PreviewResult, SandboxConfig } from './types.js';

const RUNNING_TIMEOUT_MS = 120_000;
const RUNNING_POLL_MS = 2000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface PreviewSandboxOptions {
  /** Project directory containing `sapiom.json`. */
  dir: string;
  /** Which sandbox to deploy (omit when the project has exactly one). */
  name?: string;
  /** Explicit API key; falls back to ambient `SAPIOM_API_KEY` if omitted. */
  apiKey?: string;
  /** Override the compute/sandbox service base URL. */
  servicesBaseUrl?: string;
  /** Progress sink. */
  log?: (message: string) => void;
}

export async function previewSandbox(opts: PreviewSandboxOptions): Promise<PreviewResult> {
  const cfg = getSandbox(opts.dir, opts.name);
  const log = opts.log ?? (() => {});
  const sapiom = createClient({ apiKey: opts.apiKey });
  const baseUrl = opts.servicesBaseUrl;
  const sub = cfg.source.path ?? '.';
  const sourceDir = path.resolve(opts.dir, sub);

  // 1. `git` source: get the code into a Sapiom repo BEFORE the sandbox — ensure
  //    the repo (create-if-absent) and push the local working tree. The server
  //    deploy op then checks that repo out into the sandbox.
  let deploySource: { kind: 'git'; repo: string } | undefined;
  if (cfg.source.kind === 'git') {
    const slug = cfg.source.slug;
    log(`ensuring repo "${slug}" …`);
    const repo = await sapiom.repositories.get(slug).catch(() => null);
    const cloneUrl = repo?.cloneUrl ?? (await sapiom.repositories.create(slug)).cloneUrl;
    log(`pushing ${sub} → repo "${slug}" …`);
    pushLocalDir(sourceDir, cloneUrl, opts.apiKey ?? '');
    deploySource = { kind: 'git', repo: slug };
  }

  // 2. Ensure a running sandbox (provision-if-absent, then wait).
  log(`ensuring sandbox "${cfg.name}" …`);
  await ensureRunning(sapiom, cfg, baseUrl, log);
  const box = sapiom.sandboxes.attach(cfg.name, baseUrl ? { baseUrl } : {});

  // 3. `upload` source: push the local tree straight into the sandbox.
  if (cfg.source.kind === 'upload') {
    log(`uploading ${sub} …`);
    await box.uploadDir(sourceDir);
  }

  // 4. Trigger the server-side deploy op (checkout-if-git → build → start → expose → poll).
  log('deploying …');
  const res = await box.deployPreview({
    ...(deploySource ? { source: deploySource } : {}),
    build: cfg.build,
    start: cfg.start,
    port: cfg.port,
    env: cfg.env,
  });

  return { name: cfg.name, url: res.url, status: res.status, logs: res.logs };
}

/** Create the sandbox if absent, then poll until it reports `running`. */
async function ensureRunning(
  sapiom: Sapiom,
  cfg: SandboxConfig,
  baseUrl: string | undefined,
  log: (m: string) => void,
): Promise<void> {
  const getOpts = baseUrl ? { baseUrl } : {};
  const existing = await sapiom.sandboxes.get(cfg.name, getOpts).catch(() => null);

  if (!existing) {
    log(`creating sandbox "${cfg.name}" …`);
    const createArgs = {
      name: cfg.name,
      port: cfg.port,
      ...(cfg.tier ? { tier: cfg.tier } : {}),
      ...(cfg.ttl ? { ttl: cfg.ttl } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
    await sapiom.sandboxes.create(createArgs as Parameters<typeof sapiom.sandboxes.create>[0]);
  }

  const deadline = Date.now() + RUNNING_TIMEOUT_MS;
  for (;;) {
    const info = await sapiom.sandboxes.get(cfg.name, getOpts);
    if (info.status === 'running') return;
    if (info.status === 'failed') {
      throw new PreviewOperationError({
        code: 'SANDBOX_FAILED',
        message: `Sandbox '${cfg.name}' failed to start.`,
        hint: info.error,
      });
    }
    if (Date.now() > deadline) {
      throw new PreviewOperationError({
        code: 'SANDBOX_NOT_READY',
        message: `Sandbox '${cfg.name}' did not reach 'running' in time (status: ${info.status}).`,
      });
    }
    await sleep(RUNNING_POLL_MS);
  }
}
