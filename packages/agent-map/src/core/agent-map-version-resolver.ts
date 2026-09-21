import type { AgentMapVersion, AgentMapVersionRef, StudioProjectId } from "../shared/agent-map.js";
import { validateAgentMapVersionHistory } from "./agent-map-version.js";

export class AgentMapVersionResolutionError extends Error {
  constructor(readonly code: "version_not_found" | "source_mismatch" | "cross_project_reference") {
    super(code.replace(/_/gu, " "));
    this.name = "AgentMapVersionResolutionError";
  }
}

export class AgentMapVersionResolver {
  constructor(
    private readonly projectId: StudioProjectId,
    private readonly versions: readonly AgentMapVersion[],
    private readonly current: AgentMapVersionRef | null,
  ) {
    validateAgentMapVersionHistory(versions, projectId);
    const tail = versions.at(-1);
    if ((tail === undefined) !== (current === null) || (tail && current && (
      tail.projectId !== current.projectId ||
      tail.versionId !== current.versionId ||
      tail.contentDigest !== current.contentDigest
    ))) throw new AgentMapVersionResolutionError("source_mismatch");
  }

  readCurrent(): AgentMapVersion | null {
    return this.current ? this.readExact(this.current) : null;
  }

  readExact(ref: AgentMapVersionRef): AgentMapVersion {
    if (ref.projectId !== this.projectId) throw new AgentMapVersionResolutionError("cross_project_reference");
    const version = this.versions.find(({ versionId }) => versionId === ref.versionId);
    if (!version) throw new AgentMapVersionResolutionError("version_not_found");
    if (version.contentDigest !== ref.contentDigest) throw new AgentMapVersionResolutionError("source_mismatch");
    return structuredClone(version);
  }
}
