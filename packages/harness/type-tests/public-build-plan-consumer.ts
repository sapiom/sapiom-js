import {
  AGENT_BRIEF_DIGEST_VERSION,
  AGENT_BRIEF_SCHEMA_VERSION,
  AgentBriefCompilationError,
  BuilderBootstrapLimitError,
  compileAgentBriefs,
  createBuilderBootstrapContext,
  evaluateBuildPlanImpact,
  serializeBuilderBootstrapContext,
  type AgentBriefVersionRecord,
  type AgentMapGraph,
  type AssignmentImpact,
  type BuildMilestoneSummary,
  type CompileAgentBriefsRequest,
  type CompileAgentBriefsResult,
  type FocusedAgentBriefProjection,
  type ImpactDigest,
  type PlanNodeSummary,
  type ProjectBuildPlanVersion,
} from "@sapiom/harness";

const compile = (
  request: CompileAgentBriefsRequest,
): CompileAgentBriefsResult => compileAgentBriefs(request);
const transitiveTypes = null as null | {
  graph: AgentMapGraph;
  plan: ProjectBuildPlanVersion;
  brief: AgentBriefVersionRecord;
  impact: AssignmentImpact;
  impactDigest: ImpactDigest;
  focused: FocusedAgentBriefProjection;
  node: PlanNodeSummary;
  milestone: BuildMilestoneSummary;
};

void [
  AGENT_BRIEF_SCHEMA_VERSION,
  AGENT_BRIEF_DIGEST_VERSION,
  AgentBriefCompilationError,
  BuilderBootstrapLimitError,
  compile,
  evaluateBuildPlanImpact,
  createBuilderBootstrapContext,
  serializeBuilderBootstrapContext,
  transitiveTypes,
];
