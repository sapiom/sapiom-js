import { AgentMapImplementationBindings } from "../core/agent-map-implementation-bindings.js";
import { samePath } from "../shared/paths.js";
import type { AgentMapRouterOptions } from "./agent-map.js";

export function createAgentMapImplementations(
  options: Pick<
    AgentMapRouterOptions,
    | "store"
    | "catalog"
    | "preferences"
    | "listWorkspaceScopes"
    | "listWorkflows"
    | "isWorkflowScanComplete"
  >,
) {
  return new AgentMapImplementationBindings(
    options.store,
    async (projectId) => {
      const project = await options.catalog.resolveIdentity(projectId);
      if (!project) return null;
      const scopes = await options.listWorkspaceScopes();
      const roots = project.rootBindings
        .filter(
          (binding) =>
            binding.status === "active" &&
            scopes.some((scope) => samePath(scope.cwd, binding.localRootRef)),
        )
        .map((binding) => binding.localRootRef);
      const workflows = await options.listWorkflows();
      const discoveryComplete = await options.isWorkflowScanComplete(roots);
      const ids = await options.preferences.agentIds(
        projectId,
        roots,
        workflows,
        discoveryComplete,
      );
      const candidates = workflows.flatMap((workflow) => {
        const agentId = ids.get(workflow.path);
        return agentId
          ? [
              {
                agentId,
                name: workflow.name,
                path: workflow.path,
                definitionId: workflow.definitionId,
              },
            ]
          : [];
      });
      return { discoveryComplete, candidates };
    },
  );
}
