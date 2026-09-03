import {
  AGENT_BRIEF_DIGEST_VERSION,
  AGENT_BRIEF_SCHEMA_VERSION,
  AgentBriefCompilationError,
  BuilderBootstrapLimitError,
  CanonicalBuildPlanImpactEvaluator,
  DeterministicAgentBriefCompiler,
  compileAgentBriefs,
  createBuilderBootstrapContext,
  evaluateBuildPlanImpact,
  serializeBuilderBootstrapContext,
  type AgentBriefVersionRecord,
  type AgentBriefCompileResult,
  type AgentBriefCompiler,
  type AgentMapGraph,
  type AssignmentImpact,
  type BuildMilestoneSummary,
  type BuildPlanImpactEvaluator,
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
const compiler: AgentBriefCompiler = new DeterministicAgentBriefCompiler();
const evaluator: BuildPlanImpactEvaluator =
  new CanonicalBuildPlanImpactEvaluator();
const result = null as AgentBriefCompileResult | null;
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
  compiler,
  evaluator,
  evaluateBuildPlanImpact,
  createBuilderBootstrapContext,
  serializeBuilderBootstrapContext,
  result,
  transitiveTypes,
];
