import { isStudioProjectId } from "../shared/project-id.js";
import { expandHome } from "./state-paths.js";
import { join } from "node:path";
import {
  StudioProjectCatalog,
  type StudioProjectPathLookup,
} from "./studio-project-catalog.js";

export type AgentMapProjectInput = { stateRoot?: string } & (
  | { kind: "host"; projectId: string }
  | { kind: "repository"; cwd: string; projectId?: string }
);
export type AgentMapProjectResolution =
  | Exclude<StudioProjectPathLookup, { kind: "resolved" }>
  | {
      kind: "resolved";
      projectId: string;
      identityVersion: number;
      stateRoot: string;
      agentMapRoot: string;
      workspacePath: string;
    };

/** Internal scope resolution. Host identity must already be authenticated.
 * Paths in this result are private adapter data, not public map payloads.
 * Reading an unknown repository never registers it or creates a map. */
export async function resolveAgentMapProject(
  input: AgentMapProjectInput,
): Promise<AgentMapProjectResolution> {
  try {
    if (input.projectId !== undefined && !isStudioProjectId(input.projectId))
      return { kind: "unregistered" };
    if (input.stateRoot === "") return { kind: "unavailable" };
    const stateRoot = expandHome(input.stateRoot ?? "~/.sapiom/harness");
    const catalog = new StudioProjectCatalog(
      join(stateRoot, "studio-projects.json"),
    );
    let lookup: StudioProjectPathLookup;
    if (input.kind === "host") {
      const project = await catalog.resolve(input.projectId);
      lookup = project
        ? { kind: "resolved", project }
        : { kind: "unregistered" };
    } else {
      if (!input.cwd.trim()) return { kind: "unavailable" };
      lookup = await catalog.lookupIdentityForPath(input.cwd, input.projectId);
    }
    if (lookup.kind !== "resolved") return lookup;
    const agentMapRoot = join(stateRoot, "agent-map");
    return {
      kind: "resolved",
      projectId: lookup.project.projectId,
      identityVersion: lookup.project.identityVersion,
      stateRoot,
      agentMapRoot,
      workspacePath: join(
        agentMapRoot,
        "projects",
        lookup.project.projectId,
        "workspace.json",
      ),
    };
  } catch {
    return { kind: "unavailable" };
  }
}
