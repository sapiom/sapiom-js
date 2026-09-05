import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsEvent } from "../shared/types.js";
import { createEventStore } from "./collector/store.js";
import {
  CreatedAgentRegistration,
  scaffoldCompletion,
} from "./created-agent-registration.js";
import { StudioWorkspacePreferenceStore } from "./studio-workspace-preferences.js";

function completion(
  dir: string,
  changes: Record<string, unknown> = {},
): AnalyticsEvent {
  return {
    eventId: "event-a",
    seq: 1,
    ts: new Date().toISOString(),
    userId: null,
    tenantId: null,
    machineId: "machine-a",
    harness: "claude-code",
    agentSessionId: null,
    type: "tool.call",
    harnessSessionId: "session-a",
    payload: {
      toolName: "mcp__sapiom__sapiom_dev_agents_scaffold",
      toolInput: JSON.stringify({ dir }),
      toolResponseSummary: JSON.stringify([
        {
          type: "text",
          text: JSON.stringify({
            targetDir: dir,
            projectName: "reviewer",
            dependenciesInstalled: true,
            gitInitialized: true,
          }),
        },
      ]),
      ...changes,
    },
  };
}

describe("scaffold completion evidence", () => {
  it("reads Claude content and Codex MCP envelopes", () => {
    const event = completion("/tmp/reviewer");
    expect(scaffoldCompletion(event)).toEqual({
      dir: "/tmp/reviewer",
      targetDir: "/tmp/reviewer",
    });
    expect(
      scaffoldCompletion(
        completion("/tmp/reviewer", {
          toolName: "sapiom_dev_agents_scaffold",
          toolResponseSummary: JSON.stringify({
            isError: false,
            content: JSON.parse(event.payload.toolResponseSummary as string),
          }),
        }),
      ),
    ).not.toBeNull();
  });
  it.each([
    { toolName: "Bash" },
    { toolName: "mcp__evil__not_sapiom_dev_agents_scaffold" },
    { toolInput: "{truncated" },
    { toolResponseSummary: "Scaffold succeeded" },
    { toolResponseSummary: JSON.stringify({ targetDir: "/tmp/reviewer" }) },
    {
      toolResponseSummary: JSON.stringify({
        isError: true,
        content: JSON.parse(
          completion("/tmp/reviewer").payload.toolResponseSummary as string,
        ),
      }),
    },
  ])("ignores incomplete or failed evidence: %j", (changes) => {
    expect(scaffoldCompletion(completion("/tmp/reviewer", changes))).toBeNull();
  });
});

describe("created agent registration", () => {
  const temporary: string[] = [];
  afterEach(async () => {
    await Promise.all(
      temporary
        .splice(0)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });
  async function fixture() {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "created-agent-")),
    );
    temporary.push(root);
    const cwd = path.join(root, "original");
    const target = path.join(root, "reviewer");
    await fs.mkdir(cwd);
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "sapiom.json"), "{}");
    const preferences = new StudioWorkspacePreferenceStore(
      path.join(root, "prefs.json"),
    );
    const events = createEventStore(path.join(root, "events.ndjson"));
    const projectId = "project_00000000-0000-4000-8000-000000000001";
    const authorize = vi.fn(
      async () =>
        ({ projectId, cwd }) as { projectId: string; cwd: string } | null,
    );
    const projectForPath = vi.fn(async () => null as string | null);
    const watch = vi.fn();
    const scan = vi.fn(async (agentPath: string) => {
      // Publication must already see membership, with no reload or parent scan.
      expect(
        await preferences.agentIds(
          projectId,
          [cwd],
          [{ path: agentPath, name: "reviewer", definitionId: null }],
          true,
        ),
      ).toHaveProperty("size", 1);
    });
    const options = {
      preferences,
      events,
      authorize,
      projectForPath,
      scan,
      watch,
    };
    return {
      ...options,
      cwd,
      target,
      projectId,
      registrar: new CreatedAgentRegistration(options),
      options,
    };
  }
  it("registers before immediate targeted discovery and idempotently recovers after restart", async () => {
    const f = await fixture();
    const event = completion(f.target);
    await f.events.append(event);
    await f.registrar.onEventPersisted(event, "runtime-a");
    expect(f.authorize).toHaveBeenCalledWith(event, "runtime-a");
    expect(f.scan).toHaveBeenCalledWith(f.target);
    expect(f.watch).toHaveBeenCalledWith(f.target);
    const before = await f.preferences.createdAgents();
    await f.registrar.close();
    await new CreatedAgentRegistration(f.options).recover(["session-a"]);
    expect(await f.preferences.createdAgents()).toEqual(before);
  });
  it("repairs an already-created sibling using recorded completion evidence", async () => {
    const f = await fixture();
    await f.events.append(completion(f.target));
    await f.registrar.recover(["session-a"]);
    expect(await f.preferences.createdAgents()).toMatchObject([
      { projectId: f.projectId, path: f.target },
    ]);
  });

  it("does not persist malformed marker metadata into the membership store", async () => {
    const f = await fixture();
    await fs.writeFile(
      path.join(f.target, "sapiom.json"),
      JSON.stringify({ name: {}, definitionId: "bad-id" }),
    );
    await f.registrar.onEventPersisted(completion(f.target), "runtime-a");
    expect(await f.preferences.createdAgents()).toMatchObject([
      { name: "reviewer", definitionId: null },
    ]);
    const restarted = new StudioWorkspacePreferenceStore(
      path.join(path.dirname(f.target), "prefs.json"),
    );
    expect(await restarted.createdAgents()).toHaveLength(1);
  });
  it.each([
    "foreign-project",
    "stale-runtime",
    "principal-changed",
    "missing-marker",
    "mismatched-result",
  ])("rejects %s without discovery or ownership writes", async (reason) => {
    const f = await fixture();
    const event = completion(f.target);
    if (reason === "foreign-project")
      f.projectForPath.mockResolvedValue("another-project");
    if (reason === "stale-runtime") f.authorize.mockResolvedValue(null);
    if (reason === "principal-changed")
      f.authorize
        .mockResolvedValueOnce({ projectId: f.projectId, cwd: f.cwd })
        .mockResolvedValue(null);
    if (reason === "missing-marker")
      await fs.unlink(path.join(f.target, "sapiom.json"));
    if (reason === "mismatched-result")
      event.payload.toolInput = JSON.stringify({ dir: f.cwd });
    await f.registrar.onEventPersisted(event, "runtime-a");
    expect(await f.preferences.createdAgents()).toEqual([]);
    expect(f.scan).not.toHaveBeenCalled();
    expect(f.watch).not.toHaveBeenCalled();
  });
});
