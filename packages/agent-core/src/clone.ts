/**
 * clone — materialize a Sapiom workflow template as a local, deployable project
 * (SAP-1357). The client half of the template handoff (design D5, "MCP is the run
 * surface"): closes browse → fork → clone → deploy → run.
 *
 * Given a registry template id (forked here) or an existing fork id, this:
 *   1. forks the template into a per-fork repo the caller owns (if templateId),
 *   2. mints a short-lived, repo-scoped clone credential,
 *   3. `git clone`s the token-bearing URL into a local checkout,
 *   4. writes `sapiom.json` recording the fork provenance,
 * so the standard `link → deploy → run` lifecycle then operates on the checkout.
 *
 * No engine definition is created here — that happens at `deploy` (D6). A fork is
 * just seeded, cloneable source until then.
 *
 * Networked operation: requires a GatewayClient. Security: the minted clone URL
 * embeds a live credential and is treated as a secret — it is never returned,
 * logged, or written to `sapiom.json` (see git.ts `cloneRepo`).
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { GatewayClient } from './client.js';
import { writeConfig } from './config.js';
import { OrchestrationError } from './errors.js';
import { cloneRepo as defaultCloneRepo, type CloneRepoOptions } from './git.js';

/** Response of `POST /v1/workflows/templates/:id/fork`. */
interface ForkTemplateResponse {
  id: string;
  templateId: string;
  repoFullName: string;
  defaultBranch: string;
}

/** Response of `POST /v1/workflows/forks/:id/clone-token`. */
interface CloneTokenResponse {
  repoFullName: string;
  defaultBranch: string;
  /** Token-bearing HTTPS URL — SECRET, never surfaced. */
  cloneUrl: string;
  expiresAt: string;
}

export interface CloneOptions {
  /**
   * Registry template id to fork, then clone. Mutually exclusive with `forkId`:
   * pass a template id to start from the gallery, or a fork id to re-clone an
   * existing fork.
   */
  templateId?: string;
  /** Existing fork id (`github_user_repos.id`) to clone — skips the fork step. */
  forkId?: string;
  /** Absolute path to clone into. Must not exist or must be empty. */
  targetDir: string;
  /**
   * Clone implementation, injectable for tests. Defaults to the real git clone.
   * @internal
   */
  cloneRepo?: (opts: CloneRepoOptions) => void;
}

export interface CloneResult {
  /** Fork record id — cache it to re-mint a clone token later. */
  forkId: string;
  /** Registry template id, when the fork was created from a template here. */
  templateId?: string;
  /** Full repo name `owner/repo` of the per-fork repo. */
  repoFullName: string;
  /** Default branch checked out. */
  defaultBranch: string;
  /** Local directory the repo was cloned into. */
  targetDir: string;
  /** ISO-8601 expiry of the (now-discarded) clone token, for observability. */
  tokenExpiresAt: string;
}

/**
 * Materialize a template/fork locally. See the module docstring for the flow.
 *
 * Throws `OrchestrationError` on bad input (`BAD_INPUT`, `DIR_NOT_EMPTY`), gateway
 * failures (`HTTP_*`, `NETWORK`), or git failures (`GIT_CLONE`).
 */
export async function clone(opts: CloneOptions, client: GatewayClient): Promise<CloneResult> {
  const { templateId, forkId, targetDir } = opts;
  const runClone = opts.cloneRepo ?? defaultCloneRepo;

  if (!templateId && !forkId) {
    throw new OrchestrationError({
      code: 'BAD_INPUT',
      message: 'Provide a templateId (to fork then clone) or a forkId (to clone an existing fork).',
    });
  }
  if (templateId && forkId) {
    throw new OrchestrationError({
      code: 'BAD_INPUT',
      message: 'Provide only one of templateId or forkId, not both.',
      hint: 'Use templateId to start from a gallery template, or forkId to re-clone an existing fork.',
    });
  }

  // Fail before any network call if the target can't receive a clone — the git
  // clone would fail anyway, and this keeps the credential-minting side effect
  // from happening on a doomed run.
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new OrchestrationError({
      code: 'DIR_NOT_EMPTY',
      message: `Target directory '${targetDir}' already exists and is not empty.`,
    });
  }

  // 1. Provision the per-fork repo (unless the caller already has a fork id).
  let resolvedForkId = forkId ?? '';
  let resolvedTemplateId = templateId;
  if (templateId) {
    const fork = await client.post<ForkTemplateResponse>(
      `/templates/${encodeURIComponent(templateId)}/fork`,
      {},
    );
    resolvedForkId = fork.id;
    resolvedTemplateId = fork.templateId;
  }

  // 2. Mint a short-lived, repo-scoped clone credential.
  const token = await client.post<CloneTokenResponse>(
    `/forks/${encodeURIComponent(resolvedForkId)}/clone-token`,
    {},
  );

  // Defense in depth: the clone URL is handed to `git clone` as a positional
  // argument. `cloneRepo` already terminates option parsing with `--`, but also
  // require an https:// URL here so a malformed/`-`-leading value from a
  // misbehaving endpoint can never reach git as anything but a URL.
  if (!token.cloneUrl.startsWith('https://')) {
    throw new OrchestrationError({
      code: 'BAD_CLONE_URL',
      message: 'The clone token endpoint returned an unexpected clone URL.',
    });
  }

  // 3. Clone into the local checkout. The parent must exist for git's cwd.
  const parent = path.dirname(path.resolve(targetDir));
  mkdirSync(parent, { recursive: true });
  runClone({
    cloneUrl: token.cloneUrl,
    targetDir,
    branch: token.defaultBranch,
    repoFullName: token.repoFullName,
    cwd: parent,
  });

  // 4. Record the fork provenance so `link`/`deploy`/`run` know what this is.
  writeConfig(targetDir, {
    repoFullName: token.repoFullName,
    defaultBranch: token.defaultBranch,
    forkId: resolvedForkId,
    ...(resolvedTemplateId ? { templateId: resolvedTemplateId } : {}),
  });

  return {
    forkId: resolvedForkId,
    ...(resolvedTemplateId ? { templateId: resolvedTemplateId } : {}),
    repoFullName: token.repoFullName,
    defaultBranch: token.defaultBranch,
    targetDir,
    tokenExpiresAt: token.expiresAt,
  };
}
