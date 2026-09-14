import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { HostedOpenCode } from "./opencode-host.js";
import {
  composeAssistantPrompt,
  recoverAssistantPrompt,
  resolveStudioAssistantContext,
  type AssistantGuidance,
} from "./studio-assistant-context.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-context-"));
  await Promise.all(
    ["project/cedar", "project/orchid", "unrelated"].map((path) =>
      mkdir(join(root, path), { recursive: true }),
    ),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function fixture(id = "studio-a") {
  const cwd = join(root, "project");
  const hosted = {
    harnessSessionId: id,
    cwd,
    isCurrent: () => true,
    signal: new AbortController().signal,
  } as HostedOpenCode;
  return {
    hosted,
    session: {
      id,
      cwd,
      projectId: "project-a",
      boundAgentPath: join(cwd, "cedar"),
    },
    selectedAgentPath: join(cwd, "orchid"),
    environment: "dev",
    workflows: ["project/cedar", "project/orchid", "unrelated"].map((path) => ({
      path: join(root, path),
      name: path,
      definitionId: 12,
      definitionSlug: "unused",
      source: "scan" as const,
    })),
    capabilities: [
      { name: "sapiom-dev", status: "unavailable" as const, tools: [] },
    ],
    guidance: [
      {
        id: "studio",
        kind: "profile" as const,
        required: true,
        source: "bundled",
        revision: "1",
        status: "available" as const,
        text: "Fixture Studio profile",
      },
    ] as AssistantGuidance[],
  };
}
it("resolves selected and bound agents separately and limits inventory to canonical workspace paths", async () => {
  const input = fixture();
  await symlink(join(root, "unrelated"), join(input.hosted.cwd, "escape"));
  input.workflows.push({
    ...input.workflows[0]!,
    path: join(input.hosted.cwd, "escape"),
  });
  const context = await resolveStudioAssistantContext(input);
  expect(context.agents).toHaveLength(2);
  await symlink(input.hosted.cwd, join(root, "alias"));
  expect(
    (
      await resolveStudioAssistantContext({
        ...input,
        selectedAgentPath: join(root, "alias", "orchid"),
      })
    ).selectedAgent,
  ).toEqual(context.selectedAgent);
  expect(context.selectedAgent).toMatchObject({
    status: "available",
    agent: { path: input.selectedAgentPath },
  });
  expect(context.boundAgent).toMatchObject({
    status: "available",
    agent: { path: input.session.boundAgentPath },
  });
  expect(context.session).toEqual({
    id: "studio-a",
    cwd: input.hosted.cwd,
    projectId: "project-a",
  });
  await expect(
    resolveStudioAssistantContext({
      ...input,
      selectedAgentPath: join(input.hosted.cwd, "escape"),
    }),
  ).rejects.toThrow("context");
  await expect(
    resolveStudioAssistantContext({
      ...input,
      selectedAgentPath: join(root, "unrelated"),
    }),
  ).rejects.toThrow("context");
});
it("rejects wrong-session, moved-workspace and revoked context resolution", async () => {
  const input = fixture();
  await expect(
    resolveStudioAssistantContext({
      ...input,
      session: { ...input.session, id: "studio-b" },
    }),
  ).rejects.toThrow("context");
  await expect(
    resolveStudioAssistantContext({
      ...input,
      session: { ...input.session, cwd: root },
    }),
  ).rejects.toThrow("context");
  input.hosted.isCurrent = () => false;
  await expect(resolveStudioAssistantContext(input)).rejects.toThrow("context");
});
it("preserves absent, omitted and deleted targets without selecting a remaining agent", async () => {
  const input = fixture();
  expect(
    (await resolveStudioAssistantContext({ ...input, selectedAgentPath: null }))
      .selectedAgent,
  ).toEqual({ status: "none" });
  expect(
    (
      await resolveStudioAssistantContext({
        ...input,
        selectedAgentPath: undefined,
      })
    ).selectedAgent,
  ).toEqual({ status: "not-provided" });
  await rm(input.selectedAgentPath, { recursive: true });
  const context = await resolveStudioAssistantContext(input);
  expect(context.selectedAgent).toEqual({
    status: "unavailable",
    path: input.selectedAgentPath,
  });
  expect(context.agents).toHaveLength(1);
});
it("detaches snapshots and revises only when their actual input changes", async () => {
  const input = fixture();
  const before = await resolveStudioAssistantContext(input);
  expect((await resolveStudioAssistantContext(input)).revision).toBe(
    before.revision,
  );
  input.guidance[0]!.text = "Changed rules";
  const after = await resolveStudioAssistantContext(input);
  expect(after.revision).not.toBe(before.revision);
  expect(before.guidance[0]!.text).toBe("Fixture Studio profile");
  const other = await resolveStudioAssistantContext(fixture("studio-b"));
  expect(other.revision).not.toBe(before.revision);
  expect(before.session.id).toBe("studio-a");
});
it("composes provider sources once and recovers exactly the admitted snapshot", async () => {
  const input = fixture();
  input.guidance.push(
    {
      id: "rules",
      kind: "project",
      required: false,
      source: "AGENTS.md",
      revision: "2",
      status: "available",
      text: "PROJECT_RULE_MARKER",
    },
    {
      id: "skill",
      kind: "skill",
      required: true,
      source: "bundled",
      revision: "3",
      status: "available",
      location: "/managed/skills/authoring/SKILL.md",
    },
    {
      id: "brief",
      kind: "continuation",
      required: true,
      source: "recorded:prior",
      revision: "4",
      status: "available",
      text: "CONTINUE_BRIEF_MARKER",
    },
  );
  const context = await resolveStudioAssistantContext(input);
  const original = composeAssistantPrompt(context).system;
  expect(original).toMatch(/^StudioAssistantResult\/v2:[a-f0-9-]{36}\n/);
  const recovered = recoverAssistantPrompt(original).system;
  const tail = (value: string) =>
    value.slice(value.indexOf("\n\nStudioAssistantContext/v1\n"));
  expect(tail(recovered)).toBe(tail(original));
  expect(recovered).not.toBe(original);
  expect(recovered.match(/CONTINUE_BRIEF_MARKER/g)).toHaveLength(1);
  expect(recovered).toContain("PROJECT_RULE_MARKER");
  expect(recovered).toContain("/managed/skills/authoring/SKILL.md");
});
it("fails explicitly for unavailable required guidance and pre-context recovery", async () => {
  const context = await resolveStudioAssistantContext(fixture());
  context.guidance.push({
    id: "required-skill",
    kind: "skill",
    required: true,
    source: "bundled",
    revision: null,
    status: "unavailable",
  });
  expect(() => composeAssistantPrompt(context)).toThrow("context");
  context.guidance[1]!.required = false;
  expect(composeAssistantPrompt(context).system).toContain(
    '"status":"unavailable"',
  );
  context.guidance[0]!.text = "";
  expect(() => composeAssistantPrompt(context)).toThrow("context");
  expect(() => recoverAssistantPrompt(undefined)).toThrow("context");
});
