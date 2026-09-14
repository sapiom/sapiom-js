import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ResolvedEnvironment } from "@sapiom/mcp/auth";
import type { HostedOpenCode } from "../core/opencode-host.js";
import type { HarnessSession } from "../shared/types.js";
import type { StudioProjectIdentity } from "../core/studio-project-catalog.js";
import {
  composeAssistantPrompt,
  recoverAssistantPrompt,
} from "../core/studio-assistant-context.js";
import {
  createAssistantContextResolver,
  createAssistantContextCandidateResolver,
} from "./studio-assistant.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-context-providers-"));
  await Promise.all(["cedar", "orchid"].map((name) => mkdir(join(root, name))));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fixture() {
  const abort = new AbortController();
  const session = {
    id: "studio-a",
    cwd: root,
    boundWorkflowPath: join(root, "cedar"),
    agentMapIdentity: {
      projectId: "project-a",
      userId: "user-a",
      sessionId: "studio-a",
    },
  } as HarnessSession;
  const hosted = {
    contextAuthorityScope: "a".repeat(64),
    harnessSessionId: session.id,
    cwd: root,
    signal: abort.signal,
    isCurrent: () => !abort.signal.aborted,
    server: {
      fetchJson: vi.fn().mockResolvedValue({ sapiom: { status: "connected" } }),
    },
  } as unknown as HostedOpenCode;
  const project: StudioProjectIdentity = {
    projectId: "project-a",
    identityVersion: 1,
    displayName: "Project",
    rootBindings: [
      { id: "root", repositoryId: null, localRootRef: root, status: "active" },
    ],
    legacyWorkspaceKeys: [],
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
  return {
    project,
    session,
    hosted,
    abort,
    options: {
      getSession: () => session,
      resolveProject: async () => project,
      getWorkflows: async () =>
        ["cedar", "orchid"].map((name) => ({
          name,
          path: join(root, name),
          definitionId: 12,
          definitionSlug: "private",
          source: "scan" as const,
        })),
      getEnvironment: () => ({ name: "dev" }) as ResolvedEnvironment,
      loadSystemPrompt: async () => "Studio fixture guidance",
    },
  };
}

it("captures binding before providers wait and reports actual capability and missing-loader states", async () => {
  const { session, hosted, options } = fixture();
  const resolve = createAssistantContextResolver({
    ...options,
    loadSystemPrompt: async () => {
      session.boundWorkflowPath = join(root, "orchid");
      return "Studio fixture guidance";
    },
  });
  const first = await resolve(hosted, join(root, "orchid"));
  expect(first.boundAgent).toMatchObject({
    agent: { path: join(root, "cedar") },
  });
  expect(first.selectedAgent).toMatchObject({
    agent: { path: join(root, "orchid") },
  });
  expect(first.agents.every((agent) => agent.definitionId === null)).toBe(true);
  expect(first.capabilities).toEqual([
    { name: "sapiom", status: "available", tools: [] },
    { name: "sapiom-dev", status: "unavailable", tools: [] },
    { name: "agent-map", status: "unavailable", tools: [] },
  ]);
  expect(
    first.guidance.filter((source) => source.status === "not-configured"),
  ).toHaveLength(2);
  expect(
    first.guidance.find((source) => source.id === "studio-project-role")?.text,
  ).toContain("ordinary writable coding agent");
  expect((await resolve(hosted, null)).revision).not.toBe(first.revision);
  vi.mocked(hosted.server.fetchJson).mockRejectedValue(new Error("offline"));
  expect((await resolve(hosted)).capabilities[0]?.status).toBe("configured");
});

it("authorizes sibling roots without changing native cwd or exposing foreign paths", async () => {
  const { project, hosted, session, options } = fixture();
  session.cwd = hosted.cwd = join(root, "cedar");
  project.rootBindings = ["cedar", "orchid"].map((name) => ({
    id: name,
    repositoryId: null,
    localRootRef: join(root, name),
    status: "active",
  }));
  const foreign = join(root, "foreign");
  await mkdir(foreign);
  await symlink(foreign, join(root, "orchid", "escape"), "junction");
  const resolve = createAssistantContextResolver(options);
  const context = await resolve(hosted, join(root, "orchid"));
  expect(context.session.cwd).toBe(join(root, "cedar"));
  expect(context.selectedAgent).toMatchObject({
    agent: { path: join(root, "orchid") },
  });
  expect(context.agents).toHaveLength(2);
  await expect(resolve(hosted, foreign)).rejects.toThrow("context");
  await expect(resolve(hosted, join(root, "orchid", "escape"))).rejects.toThrow(
    "context",
  );
  project.rootBindings[1]!.status = "missing";
  await expect(resolve(hosted, join(root, "orchid"))).rejects.toThrow(
    "context",
  );
  expect((await resolve(hosted, null)).agents).toHaveLength(1);
  project.rootBindings[0]!.status = "missing";
  await expect(resolve(hosted, null)).rejects.toThrow("context");
});

it.each(["project", "principal", "roots"])(
  "rejects %s changes while providers resolve",
  async (change) => {
    const { project, session, hosted, options } = fixture();
    const resolve = createAssistantContextResolver({
      ...options,
      loadSystemPrompt: async () => {
        if (change === "roots") project.rootBindings[0]!.status = "missing";
        else
          session.agentMapIdentity = {
            ...session.agentMapIdentity!,
            ...(change === "project"
              ? { projectId: "other" }
              : { userId: "other" }),
          };
        return "Studio fixture guidance";
      },
    });
    await expect(resolve(hosted)).rejects.toThrow("context");
  },
);

it("passes validated authority to sibling loaders and preserves their revisions through composition", async () => {
  const { hosted, options, abort } = fixture();
  const sources = [
    {
      id: "rules",
      kind: "project" as const,
      required: true,
      source: "AGENTS.md",
      status: "available" as const,
      revision: "rules-v1",
      text: "RULES_MARKER",
    },
    {
      id: "skill",
      kind: "skill" as const,
      required: true,
      source: "bundled",
      status: "available" as const,
      revision: "skill-v1",
      location: "/private/skill/SKILL.md",
    },
    {
      id: "brief",
      kind: "continuation" as const,
      required: true,
      source: "recorded",
      status: "available" as const,
      revision: "brief-v1",
      text: "BRIEF_MARKER",
    },
  ];
  const loadGuidance = vi.fn(async () => sources);
  const resolve = createAssistantContextResolver({ ...options, loadGuidance });
  const first = await resolve(hosted, join(root, "orchid"));
  expect(loadGuidance).toHaveBeenCalledWith(
    expect.objectContaining({
      session: { id: "studio-a", cwd: root, projectId: "project-a" },
    }),
    hosted,
    expect.any(AbortSignal),
  );
  expect(
    composeAssistantPrompt(first).system.match(/BRIEF_MARKER/g),
  ).toHaveLength(1);
  sources[0]!.text = "NEW_RULES_MARKER";
  sources[0]!.revision = "rules-v2";
  expect((await resolve(hosted)).revision).not.toBe(first.revision);
  expect(first.guidance.find((source) => source.id === "rules")?.text).toBe(
    "RULES_MARKER",
  );
  loadGuidance.mockImplementationOnce(async () => {
    abort.abort();
    return sources;
  });
  await expect(resolve(hosted)).rejects.toThrow();
});

it("retains exact profile bytes and complete supplied packages through the typed provider seam", async () => {
  const { hosted, options } = fixture();
  const {
    createAssistantSource,
    encodeAssistantSkillPackage,
    validateAssistantMaterials,
  } = await import("../core/assistant-sources.js");
  const bytes = encodeAssistantSkillPackage([
    {
      path: "SKILL.md",
      bytes: Buffer.from("Use resource\r\n"),
      executable: false,
    },
    {
      path: "assets/pixel",
      bytes: new Uint8Array([0, 255]),
      executable: false,
    },
  ]);
  const source = createAssistantSource(
    {
      id: "skill",
      kind: "skill",
      required: true,
      source: "trusted:fixture",
      authorityScope: hosted.contextAuthorityScope,
    },
    { format: "skill-package", bytes },
  );
  const loadGuidance = vi.fn(async () => [
    {
      ...source,
      metadata: {
        id: "skill",
        kind: "skill" as const,
        required: true,
        source: "trusted:fixture",
        status: "available" as const,
        revision: "release-label",
      },
    },
  ]);
  const resolve = createAssistantContextCandidateResolver({
    ...options,
    loadSystemPrompt: async () => "Exact profile\r\nbytes\n",
    loadGuidance,
  });
  const signal = new AbortController().signal;
  const candidate = await resolve(hosted, join(root, "orchid"), signal);
  source.material!.bytes.fill(0);
  bytes.fill(0);
  const retained = validateAssistantMaterials(
    candidate.instructionSet,
    candidate.materials,
    hosted.contextAuthorityScope,
  );
  expect(retained.get("studio-profile")).toEqual({
    format: "utf8",
    text: "Exact profile\r\nbytes\n",
  });
  expect(retained.get("skill")).toMatchObject({
    format: "skill-package",
    members: expect.arrayContaining([
      expect.objectContaining({
        path: "assets/pixel",
        bytes: new Uint8Array([0, 255]),
      }),
    ]),
  });
  expect(candidate.context.selectedAgent).toMatchObject({
    agent: { path: join(root, "orchid") },
  });
  expect(
    candidate.context.guidance.find((source) => source.id === "skill"),
  ).not.toHaveProperty("location");
  expect(loadGuidance).toHaveBeenCalledWith(
    expect.objectContaining({
      session: expect.objectContaining({ id: "studio-a" }),
    }),
    hosted,
    expect.any(AbortSignal),
  );
});

it("retains explicit empty discovery defaults and cancels all IO providers with admission", async () => {
  const { hosted, options } = fixture();
  const candidate = await createAssistantContextCandidateResolver(options)(
    hosted,
    null,
    new AbortController().signal,
  );
  expect(
    candidate.instructionSet.sources.filter(
      (source) => source.status === "not-configured",
    ),
  ).toHaveLength(2);
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  const collect = (signal?: AbortSignal) => {
    signals.push(signal!);
  };
  const resolve = createAssistantContextCandidateResolver({
    ...options,
    getWorkflows: async (signal) => {
      collect(signal);
      return options.getWorkflows();
    },
    loadSystemPrompt: async (signal) => {
      collect(signal);
      return options.loadSystemPrompt();
    },
    loadCapabilities: async (_hosted, signal) => {
      collect(signal);
      return [];
    },
    loadGuidance: async (_context, _hosted, signal) => {
      collect(signal);
      controller.abort(new Error("cancelled providers"));
      return [];
    },
  });
  await expect(resolve(hosted, null, controller.signal)).rejects.toThrow(
    "cancelled providers",
  );
  expect(signals).toHaveLength(4);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

it.each(["project", "principal", "roots"])(
  "rechecks %s authority after typed guidance resolves",
  async (change) => {
    const { project, session, hosted, options } = fixture();
    const resolve = createAssistantContextCandidateResolver({
      ...options,
      loadGuidance: async () => {
        if (change === "roots") project.rootBindings[0]!.status = "missing";
        else
          session.agentMapIdentity = {
            ...session.agentMapIdentity!,
            ...(change === "project"
              ? { projectId: "other" }
              : { userId: "other" }),
          };
        return [];
      },
    });
    await expect(
      resolve(hosted, null, new AbortController().signal),
    ).rejects.toThrow("context");
  },
);

it("preserves validated fallback provenance through legacy recovery", async () => {
  const { hosted, options } = fixture();
  const context = await createAssistantContextResolver({
    ...options,
    loadSystemPrompt: async () => {
      throw new Error("offline");
    },
  })(hosted, null);
  expect(context.guidance[0]?.fallback?.fromSource).toBe("host:studio-profile");
  const { system } = composeAssistantPrompt(context);
  const recovered = recoverAssistantPrompt(system).system;
  expect(recovered.slice(recovered.indexOf("StudioAssistantContext/v1"))).toBe(
    system.slice(system.indexOf("StudioAssistantContext/v1")),
  );
  expect(recovered).not.toBe(system);
});
