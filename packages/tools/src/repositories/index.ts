/**
 * `repositories` capability — in-network git repos: create, get, list, delete, and
 * `repo.pushFromSandbox(sandbox)` to commit + push a sandbox checkout.
 *
 *   import { repositories } from "@sapiom/tools";
 *   const repo = await repositories.create("my-app");
 *   // … an agent or your code writes files in a sandbox checkout of the repo …
 *   await repo.pushFromSandbox(box, { message: "build: page" });
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { resolveServiceUrl } from "../_client/service-url.js";
import type { Sandbox } from "../sandboxes/index.js";

const DEFAULT_BASE_URL = resolveServiceUrl("git", process.env.SAPIOM_GIT_URL);

/** `GET`/`list` shape from the git gateway. */
interface RepoSummary {
  slug: string;
  cloneUrl: string;
  status: string;
  createdAt: string;
}

/** `POST` (create) shape — note: no `status`, and `cloneUrl` is unauthenticated. */
interface CreateRepositoryResponse {
  tenantId: string;
  slug: string;
  cloneUrl: string;
  auth: {
    scheme: "basic";
    username: string;
    password: string;
    example: string;
  };
}

export interface PushResult {
  /** True once your work has been pushed to the repo. */
  pushed: boolean;
  /** The pushed commit SHA, when available. */
  sha: string | null;
  /** The branch it was pushed to, when available. */
  branch?: string | null;
}

/** A connected in-network repository. */
export class Repository {
  readonly slug: string;
  /** Unauthenticated clone origin (see module note on auth). */
  readonly cloneUrl: string;
  readonly status: string;

  private readonly transport: Transport;
  private readonly baseUrl: string;

  private constructor(
    fields: { slug: string; cloneUrl: string; status: string },
    transport: Transport,
    baseUrl: string,
  ) {
    this.slug = fields.slug;
    this.cloneUrl = fields.cloneUrl;
    this.status = fields.status;
    this.transport = transport;
    this.baseUrl = baseUrl;
  }

  static async create(
    slug: string,
    transport: Transport = defaultTransport(),
    baseUrl = DEFAULT_BASE_URL,
  ): Promise<Repository> {
    const r = await transport.request<CreateRepositoryResponse>(
      `${baseUrl}/v1/git/repositories`,
      {
        method: "POST",
        body: JSON.stringify({ slug }),
      },
    );
    // create doesn't return a status; a just-created repo is active.
    return new Repository(
      { slug: r.slug, cloneUrl: r.cloneUrl, status: "active" },
      transport,
      baseUrl,
    );
  }

  static async get(
    slug: string,
    transport: Transport = defaultTransport(),
    baseUrl = DEFAULT_BASE_URL,
  ): Promise<Repository> {
    const r = await transport.request<RepoSummary>(
      `${baseUrl}/v1/git/repositories/${encodeURIComponent(slug)}`,
    );
    return new Repository(r, transport, baseUrl);
  }

  static async list(
    transport: Transport = defaultTransport(),
    baseUrl = DEFAULT_BASE_URL,
  ): Promise<Repository[]> {
    const r = await transport.request<{ repositories: RepoSummary[] }>(
      `${baseUrl}/v1/git/repositories`,
    );
    return r.repositories.map((s) => new Repository(s, transport, baseUrl));
  }

  static async delete(
    slug: string,
    transport: Transport = defaultTransport(),
    baseUrl = DEFAULT_BASE_URL,
  ): Promise<void> {
    await transport
      .request(`${baseUrl}/v1/git/repositories/${encodeURIComponent(slug)}`, {
        method: "DELETE",
      })
      .catch(() => undefined);
  }

  /** Adopt a known repo without a round-trip (e.g. one returned from another step). */
  static attach(
    slug: string,
    cloneUrl: string,
    transport: Transport = defaultTransport(),
    baseUrl = DEFAULT_BASE_URL,
  ): Repository {
    return new Repository(
      { slug, cloneUrl, status: "active" },
      transport,
      baseUrl,
    );
  }

  /** Delete this repository. */
  delete(): Promise<void> {
    return Repository.delete(this.slug, this.transport, this.baseUrl);
  }

  /**
   * Commit and push this repo's working tree from a sandbox checkout. Commits any
   * pending changes and pushes the current commit, so the agent's work is
   * published whether it left changes uncommitted, already committed them, or
   * both. Returns `{ pushed, sha, branch }`; throws if the push fails.
   *
   * `workingDirectory` defaults to the repo's checkout at `/workspace/<slug>`
   * (where a coding agent run with `gitRepository: repo` clones it).
   */
  async pushFromSandbox(
    sandbox: Sandbox,
    opts: { message?: string; workingDirectory?: string } = {},
  ): Promise<PushResult> {
    return this.transport.request<PushResult>(
      `${this.baseUrl}/v1/git/repositories/${encodeURIComponent(this.slug)}/push-from-sandbox`,
      {
        method: "POST",
        body: JSON.stringify({
          executionEnvironmentId: sandbox.name,
          ...(opts.workingDirectory
            ? { workingDirectory: opts.workingDirectory }
            : {}),
          ...(opts.message ? { message: opts.message } : {}),
        }),
      },
    );
  }
}

// Ambient-bound namespace functions.
export function create(slug: string): Promise<Repository> {
  return Repository.create(slug);
}
export function get(slug: string): Promise<Repository> {
  return Repository.get(slug);
}
export function list(): Promise<Repository[]> {
  return Repository.list();
}
export function attach(slug: string, cloneUrl: string): Repository {
  return Repository.attach(slug, cloneUrl);
}
function deleteRepository(slug: string): Promise<void> {
  return Repository.delete(slug);
}
export { deleteRepository as delete };
