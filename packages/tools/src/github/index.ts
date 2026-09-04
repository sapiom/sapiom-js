/**
 * `github` capability — tenant-scoped GitHub methods executed server-side in the
 * connectors gateway (AGENT-314 / Path 2). The args are POSTed to the gateway's
 * method-dispatch route on the run credential (`x-sapiom-api-key`); the gateway
 * resolves the tenant's GitHub credential (a static Personal Access Token) INTERNALLY
 * and calls GitHub — the PAT NEVER crosses this boundary, only the result comes back.
 *
 *   import { github } from "@sapiom/tools";
 *   const repos = await github.listRepos({ visibility: "all" });
 *
 * Or on the step context: `ctx.sapiom.github.listRepos()`.
 *
 * WHY this exists: a run must call GitHub WITHOUT the PAT ever living in the run env
 * or on disk. Unlike Google's OAuth `token()` materialization, GitHub uses a `static`
 * credential the gateway injects itself — so there is NO SDK-side credential surface
 * at all, and NO `@octokit`/GitHub SDK dependency. This module only shapes the request.
 *
 * Wire: `POST ${baseUrl}/connectors/v1/github/methods/listRepos`, body = the args
 * object (or `{}` when called with no args). Non-2xx throws (Transport.request),
 * carrying the gateway body: 404 connector_not_found (connect GitHub first),
 * 400 connector_method_invalid_args, 502 connector_method_upstream_failed.
 */
import { Transport, defaultTransport } from "../_client/index.js";

// Same tools host agents/models resolve — via SAPIOM_TOOLS_BASE. No new per-cap config.
const DEFAULT_BASE_URL =
  process.env.SAPIOM_TOOLS_BASE ?? "https://tools.sapiom.ai";

/**
 * Arguments for {@link listRepos}. All optional — call with no args to list the first
 * page of every repo the tenant's PAT can see. `perPage`/`page` paginate; `visibility`
 * filters by repo visibility. Args pass through to the gateway untouched (no
 * normalization); when omitted, `{}` crosses the wire.
 */
export interface ListReposArgs {
  perPage?: number;
  page?: number;
  visibility?: "all" | "public" | "private";
}

/** A repository as returned by the gateway's GitHub method dispatch. */
export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  htmlUrl: string;
  description: string | null;
}

/** List the tenant's GitHub repositories, executed server-side in the gateway. */
export async function listRepos(
  args?: ListReposArgs,
  transport: Transport = defaultTransport(),
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<GitHubRepo[]> {
  return transport.request<GitHubRepo[]>(
    `${baseUrl}/connectors/v1/github/methods/listRepos`,
    {
      method: "POST",
      body: JSON.stringify(args ?? {}),
    },
  );
}
