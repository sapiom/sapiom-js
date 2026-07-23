/**
 * clone — materialize a Sapiom workflow locally, either as a fresh template/fork
 * checkout (SAP-1357) or by pulling an already-deployed workflow's live source by
 * `definitionId` (SAP-1839). The client half of two handoffs that share one flow:
 *   - templateId/forkId: browse → fork → clone → deploy → run.
 *   - definitionId: an existing deployed workflow → clone its current build-repo
 *     source → edit → redeploy, round-trip-consistently.
 *
 * Given exactly one of a registry template id, an existing fork id, or a deployed
 * definition id, this:
 *   1. forks the template into a per-fork repo the caller owns (templateId only),
 *   2. mints a short-lived, repo-scoped clone credential — from the per-fork repo
 *      (templateId/forkId) or the engine's live `ag-*` build repo (definitionId),
 *   3. `git clone`s the token-bearing URL into a local checkout,
 *   4. writes `sapiom.json` recording the provenance,
 * so the standard `link → deploy → run` lifecycle then operates on the checkout.
 * The definitionId path writes `definitionId` directly, pre-linking the checkout
 * so `link` is never required before the first `deploy`.
 *
 * No engine definition is created by the templateId/forkId path — that happens at
 * `deploy` (D6). A fork is just seeded, cloneable source until then. The
 * definitionId path is the opposite: the definition already exists, and cloning
 * it never creates or changes one.
 *
 * Networked operation: requires a GatewayClient. Security: the minted clone URL
 * embeds a live credential and is treated as a secret — it is never returned,
 * logged, or written to `sapiom.json` (see git.ts `cloneRepo`).
 *
 * `definitionId` representation: the engine id is a bigint. The harness surfaces
 * it as a `number` (`workspace-context.ts`); the rest of agent-core (`config.ts`,
 * `link.ts`, `deploy.ts`, `types.ts`) uniformly treats definition ids as opaque
 * `string`s to avoid float precision loss on large bigints. This module keeps
 * that convention — `CloneOptions.definitionId` is a `string` — and callers that
 * only have a `number` (e.g. the MCP tool, on behalf of the harness) normalize at
 * that boundary with `String(definitionId)` before calling in.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { GatewayClient } from './client.js';
import { writeConfig } from './config.js';
import { AgentOperationError } from './errors.js';
import { cloneRepo as defaultCloneRepo, type CloneRepoOptions } from './git.js';

/** Response of `POST /v1/workflows/templates/:id/fork`. */
interface ForkTemplateResponse {
  id: string;
  templateId: string;
  repoFullName: string;
  defaultBranch: string;
}

/**
 * Response of `POST /v1/workflows/forks/:id/clone-token` and
 * `POST /v1/workflows/definitions/:id/clone-token` — identical shape
 * (`CloneTokenResponseDto` on the backend).
 */
interface CloneTokenResponse {
  repoFullName: string;
  defaultBranch: string;
  /** Token-bearing HTTPS URL — SECRET, never surfaced. */
  cloneUrl: string;
  expiresAt: string;
}

export interface CloneOptions {
  /**
   * Registry template id to fork, then clone. Mutually exclusive with `forkId`
   * and `definitionId`: pass a template id to start from the gallery, a fork id
   * to re-clone an existing fork, or a definitionId to pull a deployed
   * workflow's live source.
   */
  templateId?: string;
  /** Existing fork id (`github_user_repos.id`) to clone — skips the fork step. */
  forkId?: string;
  /**
   * Deployed workflow's definition id (engine bigint, as a string — see the
   * module docstring) to clone. Skips the fork step entirely and clones the
   * engine's live `ag-*` build-repo source directly, so the checkout always
   * matches what is actually deployed. Writes `definitionId` into `sapiom.json`,
   * pre-linking the checkout (`link` is never required before the first
   * `deploy`). Mutually exclusive with `templateId` and `forkId`.
   */
  definitionId?: string;
  /** Absolute path to clone into. Must not exist or must be empty. */
  targetDir: string;
  /**
   * Clone implementation, injectable for tests. Defaults to the real git clone.
   * @internal
   */
  cloneRepo?: (opts: CloneRepoOptions) => void;
}

export interface CloneResult {
  /**
   * Fork record id — cache it to re-mint a clone token later. Absent for a
   * definitionId clone (there is no fork; re-mint against `definitionId` instead).
   */
  forkId?: string;
  /** Registry template id, when the fork was created from a template here. */
  templateId?: string;
  /**
   * Deployed definition id, when cloned by `definitionId` — the checkout is
   * already pre-linked (see {@link CloneOptions.definitionId}).
   */
  definitionId?: string;
  /** Full repo name `owner/repo` of the cloned repo. */
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
 * Throws `AgentOperationError` on bad input (`BAD_INPUT`, `DIR_NOT_EMPTY`), gateway
 * failures (`HTTP_*`, `NETWORK`), or git failures (`GIT_CLONE`).
 */
export async function clone(opts: CloneOptions, client: GatewayClient): Promise<CloneResult> {
  const { templateId, forkId, definitionId, targetDir } = opts;
  const runClone = opts.cloneRepo ?? defaultCloneRepo;

  const provided = [templateId, forkId, definitionId].filter((v) => v !== undefined).length;
  if (provided === 0) {
    throw new AgentOperationError({
      code: 'BAD_INPUT',
      message:
        'Provide a templateId (to fork then clone), a forkId (to clone an existing fork), or a definitionId (to clone a deployed workflow).',
    });
  }
  if (provided > 1) {
    throw new AgentOperationError({
      code: 'BAD_INPUT',
      message: 'Provide only one of templateId, forkId, or definitionId.',
      hint:
        'Use templateId to start from a gallery template, forkId to re-clone an existing fork, or definitionId to pull a deployed workflow local.',
    });
  }

  // Fail before any network call if the target can't receive a clone — the git
  // clone would fail anyway, and this keeps the credential-minting side effect
  // from happening on a doomed run.
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new AgentOperationError({
      code: 'DIR_NOT_EMPTY',
      message: `Target directory '${targetDir}' already exists and is not empty.`,
    });
  }

  // 1. Provision the per-fork repo (unless the caller already has a fork id, or
  // is cloning by definitionId, which skips forking entirely).
  let resolvedForkId = forkId;
  let resolvedTemplateId = templateId;
  if (templateId) {
    const fork = await client.post<ForkTemplateResponse>(
      `/templates/${encodeURIComponent(templateId)}/fork`,
      {},
    );
    resolvedForkId = fork.id;
    resolvedTemplateId = fork.templateId;
  }

  // 2. Mint a short-lived, repo-scoped clone credential — from the per-fork
  // repo (templateId/forkId) or the engine's live build repo (definitionId).
  const token = definitionId
    ? await client.post<CloneTokenResponse>(
        `/definitions/${encodeURIComponent(definitionId)}/clone-token`,
        {},
      )
    : await client.post<CloneTokenResponse>(
        `/forks/${encodeURIComponent(resolvedForkId as string)}/clone-token`,
        {},
      );

  // Defense in depth: the clone URL is handed to `git clone` as a positional
  // argument. `cloneRepo` already terminates option parsing with `--`, but also
  // require an https:// URL here so a malformed/`-`-leading value from a
  // misbehaving endpoint can never reach git as anything but a URL.
  if (!token.cloneUrl.startsWith('https://')) {
    throw new AgentOperationError({
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

  // 4. Record the provenance so `link`/`deploy`/`run` know what this is. The
  // definitionId path writes `definitionId` directly — the checkout is
  // pre-linked, so a subsequent `link` is never required before `deploy`.
  writeConfig(targetDir, {
    repoFullName: token.repoFullName,
    defaultBranch: token.defaultBranch,
    ...(definitionId ? { definitionId } : { forkId: resolvedForkId as string }),
    ...(resolvedTemplateId ? { templateId: resolvedTemplateId } : {}),
  });

  return {
    ...(definitionId ? { definitionId } : { forkId: resolvedForkId as string }),
    ...(resolvedTemplateId ? { templateId: resolvedTemplateId } : {}),
    repoFullName: token.repoFullName,
    defaultBranch: token.defaultBranch,
    targetDir,
    tokenExpiresAt: token.expiresAt,
  };
}
