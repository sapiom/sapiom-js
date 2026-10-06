import assert from "node:assert/strict";
import type { BootResult } from "./boot.js";

/**
 * The packaged app computes the project map in process with `@sapiom/mcp/map`
 * (scanner, TypeScript parser, `agents check`). A packaging gap there shows up
 * only here: the mock suite never loads the scanner.
 */
export async function checkProjectMap(boot: BootResult): Promise<string> {
  if (!process.env.SAPIOM_SMOKE_STUB_AGENT)
    return "SKIPPED — run via scripts/smoke.sh for an isolated fixture project";
  const base = `http://127.0.0.1:${boot.server.port}/api`;
  const get = async (path: string) => {
    const response = await fetch(base + path, {
      signal: AbortSignal.timeout(60_000),
      headers: { "X-Harness-Token": boot.bootToken },
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 500);
      assert.fail(`GET ${path}: ${response.status} ${body}`);
    }
    return response.json();
  };
  const state = (await get("/state")) as {
    workspaceScopes?: Array<{ projectId?: string }>;
  };
  const scope = state.workspaceScopes?.find((candidate) => candidate.projectId) as
    | { projectId?: string; cwd?: string }
    | undefined;
  const projectId = scope?.projectId;
  assert(projectId, "the launch folder has no Studio project");
  const body = (await get(`/projects/${projectId}/map`)) as {
    map: { systems: unknown[]; agents: unknown[]; edges: unknown[] };
  };
  assert(Array.isArray(body.map.systems) && Array.isArray(body.map.agents) && Array.isArray(body.map.edges),
    "the map response has no systems, agents or edges");
  return `map computed in process for ${scope?.cwd ?? "?"}: ${body.map.agents.length} agents, ${body.map.systems.length} systems`;
}
