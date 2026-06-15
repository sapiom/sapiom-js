/**
 * `repositories` capability — in-network git repos: create, get, list, delete, and
 * the first cross-capability mesh method, `repo.pushFromSandbox(sandbox)`.
 *
 *   import { repositories } from "@sapiom/tools";
 *   const repo = await repositories.create("my-app");
 *   // … an agent or your code writes files in a sandbox checkout of the repo …
 *   await repo.pushFromSandbox(box, { message: "build: page" });
 *
 * `pushFromSandbox` is the deterministic counterpart to a fuzzy agent step: it
 * composes the `sandboxes` capability (calls `sandbox.exec`) to commit + push the
 * repo's working tree. It references the `Sandbox` TYPE only — no module cycle.
 *
 * Note: `cloneUrl` is the unauthenticated origin. The gateway authenticates clones
 * via basic-auth (the `auth` block returned by create); inside an agent run the
 * `gitRepository` auto-clone wires that credential into the in-sandbox origin, so
 * `pushFromSandbox` doesn't need it.
 */
import { Transport, defaultTransport } from "../_client/index.js";
import type { Sandbox } from "../sandboxes/index.js";

const DEFAULT_BASE_URL = process.env.SAPIOM_GIT_URL || "https://git.services.sapiom.ai";

/** Canonical in-sandbox checkout path (matches the agent's `gitRepository` auto-clone). */
const checkoutDir = (slug: string) => `/workspace/${slug}`;

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
  auth: { scheme: "basic"; username: string; password: string; example: string };
}

export interface PushResult {
  /** False when there was nothing to commit. */
  pushed: boolean;
  sha: string | null;
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

  static async create(slug: string, transport: Transport = defaultTransport(), baseUrl = DEFAULT_BASE_URL): Promise<Repository> {
    const r = await transport.request<CreateRepositoryResponse>(`${baseUrl}/v1/git/repositories`, {
      method: "POST",
      body: JSON.stringify({ slug }),
    });
    // create doesn't return a status; a just-created repo is active.
    return new Repository({ slug: r.slug, cloneUrl: r.cloneUrl, status: "active" }, transport, baseUrl);
  }

  static async get(slug: string, transport: Transport = defaultTransport(), baseUrl = DEFAULT_BASE_URL): Promise<Repository> {
    const r = await transport.request<RepoSummary>(`${baseUrl}/v1/git/repositories/${encodeURIComponent(slug)}`);
    return new Repository(r, transport, baseUrl);
  }

  static async list(transport: Transport = defaultTransport(), baseUrl = DEFAULT_BASE_URL): Promise<Repository[]> {
    const r = await transport.request<{ repositories: RepoSummary[] }>(`${baseUrl}/v1/git/repositories`);
    return r.repositories.map((s) => new Repository(s, transport, baseUrl));
  }

  static async delete(slug: string, transport: Transport = defaultTransport(), baseUrl = DEFAULT_BASE_URL): Promise<void> {
    await transport.request(`${baseUrl}/v1/git/repositories/${encodeURIComponent(slug)}`, { method: "DELETE" }).catch(() => undefined);
  }

  /** Adopt a known repo without a round-trip (e.g. one returned from another step). */
  static attach(slug: string, cloneUrl: string, transport: Transport = defaultTransport(), baseUrl = DEFAULT_BASE_URL): Repository {
    return new Repository({ slug, cloneUrl, status: "active" }, transport, baseUrl);
  }

  /** Delete this repository. */
  delete(): Promise<void> {
    return Repository.delete(this.slug, this.transport, this.baseUrl);
  }

  /**
   * Deterministically stage + commit + push this repo's working tree FROM a
   * sandbox checkout (no LLM). Assumes the repo is checked out at the canonical
   * `/workspace/<slug>` with an authenticated `origin` (which the agent's
   * `gitRepository` auto-clone sets up). No-op when there's nothing to commit.
   */
  async pushFromSandbox(sandbox: Sandbox, opts: { message?: string } = {}): Promise<PushResult> {
    const message = (opts.message ?? `update ${this.slug}`).replace(/'/g, ""); // single-quote-safe for sh -c
    const script =
      `cd ${checkoutDir(this.slug)} && git add -A && ` +
      `if git diff --cached --quiet; then echo NO_CHANGES; else ` +
      `git -c user.email=workflow@sapiom.ai -c user.name=sapiom-workflow commit -m "${message}" >/dev/null && ` +
      `git push origin HEAD && printf "SHA:%s\\n" "$(git rev-parse HEAD)"; fi`;
    const { stdout, stderr, exitCode } = await sandbox.exec(`sh -c '${script}'`);
    const out = `${stdout}\n${stderr}`;
    if (out.includes("NO_CHANGES")) return { pushed: false, sha: null };
    const sha = out.match(/SHA:([0-9a-f]{7,40})/)?.[1] ?? null;
    if (exitCode !== 0 || !sha) {
      throw new Error(`pushFromSandbox(${this.slug}) failed (exit ${exitCode}): ${out.slice(-300)}`);
    }
    return { pushed: true, sha };
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
