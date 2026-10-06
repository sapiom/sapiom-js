/** The project map Studio draws: `sapiom_dev_map`'s output plus the header's git refs. */
import type { AgentMap } from "@sapiom/mcp/map";

export type {
  AgentMap,
  EdgeKind,
  MapAgent,
  MapEdge,
  MapSystem,
  StepGraph,
} from "@sapiom/mcp/map";

export interface ProjectMapResponse {
  projectId: string;
  displayName: string;
  map: AgentMap;
  /** Null outside a git repository: the header then offers no ref selector. */
  git: { branch: string | null; branches: string[] } | null;
}
