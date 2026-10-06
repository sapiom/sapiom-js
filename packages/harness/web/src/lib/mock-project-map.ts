/**
 * The mock build's project map (`VITE_MOCK=1`): what `sapiom_dev_map` would
 * return for a mock project, built from the project's mock agents.
 *
 * acme-app gets a small fleet beside its one registry agent (`leasing`): a
 * three-agent system joined by a launch and an event, with a shared vault key,
 * and one loose agent; screening has uncommitted changes. Its folder is a git
 * repository with two branches. Every other project draws its agents loose,
 * outside git.
 *
 * Query flags: `mockProjectMapUnlisted=1` gives an agentless project one map-only agent.
 * Query flags: `mockProjectMap=error|missing|empty` for the failure and empty
 * states; `mockProjectMapDeployed=0` drops the deploy state (no badge);
 * `mockProjectMapChips=many` gives leasing four shared resources, more than
 * its card's chip line holds.
 */
import type { WorkflowInfo } from "@shared/types";

import type { MapAgent, MapEdge, ProjectMapResponse } from "./project-map";
import { basenameOf, isWithinDir } from "./paths";

const ACME = "/Users/demo/acme-app";

function relativeTo(root: string, path: string): string {
  return path.slice(root.replace(/\/+$/, "").length + 1) || ".";
}

function fromWorkflow(root: string, workflow: WorkflowInfo): MapAgent {
  return {
    slug: workflow.definitionSlug ?? basenameOf(workflow.path),
    path: relativeTo(root, workflow.path),
    description: "",
    deployed: workflow.definitionId != null,
    changedSinceRef: false,
    shared: [],
    triggers: [],
  };
}

export function mockProjectMap(input: {
  projectId: string;
  displayName: string;
  root: string;
  workflows: readonly WorkflowInfo[];
  ref: string | null;
  params: URLSearchParams | null;
}): ProjectMapResponse | "empty" {
  const { root, ref, params } = input;
  if (params?.get("mockProjectMap") === "empty") return "empty";
  const agents = input.workflows
    .filter((workflow) => isWithinDir(root, workflow.path))
    .map((workflow) => fromWorkflow(root, workflow));
  // A defineAgent folder with no sapiom.json: the map finds it, Studio's agent list does not.
  if (params?.get("mockProjectMapUnlisted") === "1" && agents.length === 0) {
    agents.push({ slug: "unlisted", path: "unlisted", description: "", deployed: null, changedSinceRef: false, shared: [], triggers: [] });
  }
  const edges: MapEdge[] = [];
  const systems: ProjectMapResponse["map"]["systems"] = [];
  const acme = root === ACME && agents.some((agent) => agent.slug === "leasing");
  if (acme) {
    const leasing = agents.find((agent) => agent.slug === "leasing")!;
    leasing.description = "Takes a rental application and starts screening.";
    leasing.shared =
      params?.get("mockProjectMapChips") === "many"
        ? [
            "vault:APPLICANT_DB_URL",
            "db:LEASES_DB",
            "connector:SLACK_WORKSPACE",
            "vault:STRIPE_SECRET_KEY",
          ]
        : ["vault:APPLICANT_DB_URL"];
    leasing.steps = {
      entry: "apply",
      steps: [
        { id: "apply", file: "leasing/index.ts", line: 12 },
        { id: "request-screening", file: "leasing/index.ts", line: 31 },
        { id: "confirm", file: "leasing/index.ts", line: 48 },
      ],
      transitions: [
        { from: "apply", to: "request-screening", kind: "next" },
        { from: "request-screening", to: "confirm", kind: "next" },
      ],
    };
    agents.push(
      {
        slug: "screening",
        path: "screening",
        description: "Checks an applicant's credit and references.",
        deployed: false,
        // Changed against the ref, or against HEAD at Working copy (D75).
        changedSinceRef: true,
        shared: ["vault:APPLICANT_DB_URL"],
        triggers: [],
      },
      {
        slug: "applicant-notifier",
        path: "applicant-notifier",
        description: "Emails the applicant the screening result.",
        deployed: true,
        changedSinceRef: false,
        shared: [],
        triggers: [{ kind: "event", eventType: "screening.completed", source: "code" }],
      },
      {
        slug: "rent-reminder",
        path: "reminders",
        description: "Reminds tenants before rent is due.",
        deployed: null,
        changedSinceRef: false,
        shared: [],
        triggers: [{ kind: "schedule", cron: "0 9 1 * *", source: "code" }],
      },
    );
    edges.push(
      {
        from: "leasing",
        to: "screening",
        kind: "launch",
        evidence: [{ file: "leasing/index.ts", line: 34, text: 'agents.launch("screening", input)', step: "request-screening" }],
        fromStep: "request-screening",
      },
      {
        from: "screening",
        to: "applicant-notifier",
        kind: "event",
        eventType: "screening.completed",
        evidence: [{ file: "screening/index.ts", line: 52, text: 'ctx.emit("screening.completed", result)' }],
      },
    );
    systems.push({
      id: "sys-mock-leasing",
      name: "leasing",
      nameSource: "default",
      agents: ["applicant-notifier", "leasing", "screening"],
    });
  }
  if (params?.get("mockProjectMapDeployed") === "0")
    for (const agent of agents) agent.deployed = null;
  agents.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return {
    projectId: input.projectId,
    displayName: input.displayName,
    map: {
      root,
      ...(acme && ref ? { ref } : {}),
      systems,
      agents,
      edges,
      unresolved: [],
      platform: "skipped",
      labels: "unavailable",
    },
    git: acme ? { branch: "main", branches: ["feature/screening", "main"] } : null,
  };
}
