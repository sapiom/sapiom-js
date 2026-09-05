import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectAgentSession,
  ProjectBootstrapMetadata,
  ProjectBootstrapState,
} from "../shared/agent-map.js";
import type { HarnessSession } from "../shared/types.js";
import {
  ProjectBootstrapStore,
  ProjectBootstrapDispatchForbiddenError,
  type ProjectBootstrapStoreOptions,
} from "./project-bootstrap-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
  };
});

class TestBootstrapStore extends ProjectBootstrapStore {
  read(session: HarnessSession, emptyProject = true) {
    return this.load(session, emptyProject);
  }

  save(session: HarnessSession) {
    return this.writeState(this.file(session.id), this.newState(session, true));
  }
}

const PROJECT_ID = "project_00000000-0000-7000-8000-000000000001";

const USER_ID = "user-1";

const NOW = "2026-09-01T00:00:00.000Z";

interface DurableBootstrapState {
  schemaVersion: number;
  metadata: ProjectBootstrapMetadata;
  inputs: Array<{
    id: string;
    sessionId: string;
    text: string;
    acceptedAt: string;
  }>;
  dispatchingInputId: string | null;
  retryCount: number;
  emptyProject: boolean;
  attempts: Array<{
    attemptId: string;
    retryOrdinal: number;
    status: "active" | "retired" | "completed";
    phase?: "claimed" | "dispatching" | "not-submitted" | "submitted";
  }>;
  uncertainInputIds?: string[];
  uncertainInputs?: Array<{
    id: string;
    sessionId: string;
    text: string;
    acceptedAt: string;
  }>;
  receipts?: Array<{
    requestId: string | null;
    inputId: string;
    status: "queued" | "submitted" | "uncertain" | "completed";
    acceptedAt: string;
    payloadDigest: string;
  }>;
}

function projectSession(
  id = "session-1",
  bootstrap: ProjectBootstrapState = { status: "pending" },
): HarnessSession {
  const identity: ProjectAgentSession = {
    projectId: PROJECT_ID,
    sessionId: id,
    userId: USER_ID,
  };
  return {
    id,
    agentSessionId: "provider-conversation-1",
    harness: "codex",
    cwd: "/private/project",
    title: "Plan Agents",
    status: "running",
    createdAt: NOW,
    lastActiveAt: NOW,
    exitCode: null,
    boundWorkflowPath: null,
    ready: true,
    agentMapIdentity: identity,
    projectBootstrap: {
      projectId: identity.projectId,
      userId: identity.userId,
      targetSessionId: identity.sessionId,
      bootstrap: structuredClone(bootstrap),
      queuedInputIds: [],
    },
  };
}

function stateFile(root: string, sessionId: string): string {
  return path.join(root, sessionId, "input-queue.json");
}

async function readState(
  root: string,
  sessionId: string,
): Promise<DurableBootstrapState> {
  return JSON.parse(
    await fs.readFile(stateFile(root, sessionId), "utf8"),
  ) as DurableBootstrapState;
}

async function writeState(
  root: string,
  sessionId: string,
  state: DurableBootstrapState,
): Promise<void> {
  await fs.mkdir(path.dirname(stateFile(root, sessionId)), { recursive: true });
  await fs.writeFile(stateFile(root, sessionId), `${JSON.stringify(state)}\n`);
}
describe("ProjectBootstrapStore", () => {
  let root: string;
  let legacyRoot: string;
  let session: HarnessSession;
  let sessions: Map<string, HarnessSession>;
  let manager: ProjectBootstrapStoreOptions["sessionManager"];
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "project-bootstrap-store-"));
    legacyRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "project-bootstrap-store-legacy-"),
    );
    session = projectSession();
    sessions = new Map([[session.id, session]]);
    manager = {
      get: (id: string) => sessions.get(id),
      setProjectBootstrapMetadata: async (
        id: string,
        metadata: ProjectBootstrapMetadata,
      ) => {
        const target = sessions.get(id);
        if (!target) throw new Error("session missing");
        target.projectBootstrap = structuredClone(metadata);
      },
    };
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(legacyRoot, { recursive: true, force: true });
  });

  it.each(["write", "rename"] as const)(
    "removes private temporary state after a failed %s without replacing durable state",
    async (phase) => {
      const file = stateFile(root, session.id);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "last durable state");
      const failure = new Error(`injected ${phase} failure`);
      if (phase === "write") {
        const actual = await vi.importActual<typeof fs>("node:fs/promises");
        vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
          await actual.writeFile(...args);
          throw failure;
        });
      } else {
        vi.mocked(fs.rename).mockRejectedValueOnce(failure);
      }
      const store = new TestBootstrapStore({ root, sessionManager: manager });

      await expect(store.save(session)).rejects.toBe(failure);

      expect(await fs.readdir(path.dirname(file))).toEqual(["input-queue.json"]);
      expect(await fs.readFile(file, "utf8")).toBe("last durable state");
    },
  );

  it("durably schedules one project lifecycle and atomically claims its first ordinary session", async () => {
    const first = new TestBootstrapStore({
      root,
      sessionManager: manager,
    });

    await expect(first.scheduleProject(PROJECT_ID, USER_ID)).resolves.toBe(
      true,
    );
    await expect(first.scheduleProject(PROJECT_ID, USER_ID)).resolves.toBe(
      false,
    );

    const restarted = new TestBootstrapStore({
      root,
      sessionManager: manager,
    });
    await expect(
      restarted.needsProjectSession(PROJECT_ID, USER_ID),
    ).resolves.toBe(true);

    const claimed = await restarted.claimProject(session.agentMapIdentity!);
    expect(claimed).toEqual({
      projectId: PROJECT_ID,
      userId: USER_ID,
      targetSessionId: session.id,
      bootstrap: { status: "pending" },
      queuedInputIds: [],
    });
    session.projectBootstrap = claimed!;
    await expect(
      restarted.needsProjectSession(PROJECT_ID, USER_ID),
    ).resolves.toBe(false);

    const second = projectSession("session-2");
    sessions.set(second.id, second);
    await expect(
      restarted.claimProject(second.agentMapIdentity!),
    ).resolves.toBeNull();

    const intent = JSON.parse(
      await fs.readFile(
        path.join(root, "projects", `${PROJECT_ID}.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(intent).toMatchObject({
      schemaVersion: 1,
      projectId: PROJECT_ID,
      userId: USER_ID,
      targetSessionId: session.id,
      status: "claimed",
    });
    expect(JSON.stringify(intent)).not.toContain(session.cwd);
  });

  it("does not let a concurrent create steal a claim before SessionManager publishes its session", async () => {
    sessions.delete(session.id);
    const coordinator = new TestBootstrapStore({
      root,
      sessionManager: manager,
    });
    await coordinator.scheduleProject(PROJECT_ID, USER_ID);

    const first = await coordinator.claimProject(session.agentMapIdentity!);
    expect(first?.targetSessionId).toBe(session.id);

    const racing = projectSession("session-racing-create");
    expect(await coordinator.claimProject(racing.agentMapIdentity!)).toBeNull();
    await expect(
      coordinator.needsProjectSession(PROJECT_ID, USER_ID),
    ).resolves.toBe(false);

    // A proven pre-spawn failure releases only the volatile claim. The durable
    // project intent remains available for a replacement ordinary session.
    await coordinator.releaseSessionClaim(session.id);
    expect(
      await coordinator.claimProject(racing.agentMapIdentity!),
    ).toMatchObject({ targetSessionId: racing.id });
  });

  it("rejects a foreign project-intent claimant and can recover a missing claimed target", async () => {
    const coordinator = new TestBootstrapStore({
      root,
      sessionManager: manager,
    });
    await coordinator.scheduleProject(PROJECT_ID, USER_ID);
    await expect(
      coordinator.claimProject({
        ...session.agentMapIdentity!,
        userId: "foreign-user",
      }),
    ).rejects.toBeInstanceOf(ProjectBootstrapDispatchForbiddenError);

    const first = await coordinator.claimProject(session.agentMapIdentity!);
    session.projectBootstrap = first!;
    await coordinator.releaseSessionClaim(session.id);
    sessions.delete(session.id);
    const replacement = projectSession("session-replacement");
    sessions.set(replacement.id, replacement);

    const recovered = await coordinator.claimProject(
      replacement.agentMapIdentity!,
    );
    expect(recovered?.targetSessionId).toBe(replacement.id);
    expect(recovered?.bootstrap).toEqual({ status: "pending" });
  });

  it("keeps a published pre-provider exit as the bounded project failure tombstone", async () => {
    const coordinator = new TestBootstrapStore({
      root,
      sessionManager: manager,
    });
    await coordinator.scheduleProject(PROJECT_ID, USER_ID);
    const first = await coordinator.claimProject(session.agentMapIdentity!);
    session.projectBootstrap = first!;
    session.status = "exited";
    session.agentSessionId = null;

    await expect(
      coordinator.needsProjectSession(PROJECT_ID, USER_ID),
    ).resolves.toBe(false);

    const replacement = projectSession("session-replacement");
    sessions.set(replacement.id, replacement);
    await expect(
      coordinator.claimProject(replacement.agentMapIdentity!),
    ).resolves.toBeNull();

    const restarted = new TestBootstrapStore({
      root,
      sessionManager: manager,
    });
    for (let read = 0; read < 10; read += 1) {
      await expect(
        restarted.needsProjectSession(PROJECT_ID, USER_ID),
      ).resolves.toBe(false);
    }

    expect(sessions.get(session.id)).toBe(session);
    await expect(
      fs
        .readFile(path.join(root, "projects", `${PROJECT_ID}.json`), "utf8")
        .then(JSON.parse),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      projectId: PROJECT_ID,
      targetSessionId: session.id,
      status: "claimed",
    });
  });

  it("refuses replacement when an abandoned target still owns durable input", async () => {
    const coordinator = new TestBootstrapStore({
      root,
      sessionManager: manager,
    });
    await coordinator.scheduleProject(PROJECT_ID, USER_ID);
    const first = await coordinator.claimProject(session.agentMapIdentity!);
    session.projectBootstrap = first!;
    await writeState(root, session.id, {
      schemaVersion: 2,
      metadata: {
        ...structuredClone(first!),
        bootstrap: { status: "skipped", reason: "user-proceeded" },
        queuedInputIds: ["durable-user-input"],
      },
      inputs: [
        {
          id: "durable-user-input",
          sessionId: session.id,
          text: "preserve this exact request",
          acceptedAt: NOW,
        },
      ],
      dispatchingInputId: null,
      retryCount: 0,
      emptyProject: true,
      attempts: [],
    });
    session.status = "exited";
    session.agentSessionId = null;

    await expect(
      coordinator.needsProjectSession(PROJECT_ID, USER_ID),
    ).resolves.toBe(false);
    const replacement = projectSession("session-replacement-refused");
    sessions.set(replacement.id, replacement);
    await expect(
      coordinator.claimProject(replacement.agentMapIdentity!),
    ).resolves.toBeNull();

    expect((await readState(root, session.id)).inputs).toEqual([
      expect.objectContaining({
        id: "durable-user-input",
        sessionId: session.id,
        text: "preserve this exact request",
      }),
    ]);
    const intent = JSON.parse(
      await fs.readFile(
        path.join(root, "projects", `${PROJECT_ID}.json`),
        "utf8",
      ),
    ) as { targetSessionId: string };
    expect(intent.targetSessionId).toBe(session.id);
  });

  it("records real input already pending at claim time as higher priority", async () => {
    const coordinator = new TestBootstrapStore({
      root,
      sessionManager: manager,
    });
    await coordinator.scheduleProject(PROJECT_ID, USER_ID);

    const claimed = await coordinator.claimProject(
      session.agentMapIdentity!,
      true,
    );

    expect(claimed?.bootstrap).toEqual({
      status: "skipped",
      reason: "user-proceeded",
    });
  });

  it("fails closed on malformed primary state without deleting, replacing, or quarantining it", async () => {
    const directory = path.join(root, session.id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      stateFile(root, session.id),
      "{private-undelivered-input",
    );
    session.projectBootstrap!.queuedInputIds = ["unknown-undelivered-input"];
    const coordinator = new TestBootstrapStore({
      root,
      sessionManager: manager,
    });

    await expect(coordinator.read(session, true)).rejects.toThrow(
      "project bootstrap state is unavailable",
    );
    expect(await fs.readFile(stateFile(root, session.id), "utf8")).toBe(
      "{private-undelivered-input",
    );
    expect(await fs.readdir(directory)).toEqual(["input-queue.json"]);
    expect(session.projectBootstrap?.queuedInputIds).toEqual([
      "unknown-undelivered-input",
    ]);
  });

  it("rejects a persisted receipt request ID beyond the public 200-character bound", async () => {
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    await writeState(root, session.id, {
      schemaVersion: 3,
      metadata: structuredClone(session.projectBootstrap!),
      inputs: [],
      dispatchingInputId: null,
      retryCount: 0,
      emptyProject: false,
      attempts: [],
      uncertainInputIds: [],
      uncertainInputs: [],
      receipts: [
        {
          requestId: "r".repeat(201),
          inputId: "completed-input",
          status: "completed",
          acceptedAt: NOW,
          payloadDigest: "a".repeat(64),
        },
      ],
    });
    const original = await fs.readFile(stateFile(root, session.id), "utf8");
    const coordinator = new TestBootstrapStore({
      root,
      sessionManager: manager,
    });

    await expect(coordinator.read(session, false)).rejects.toThrow(
      "project bootstrap state is unavailable",
    );
    expect(await fs.readFile(stateFile(root, session.id), "utf8")).toBe(
      original,
    );
  });

  it("rejects a session identity that could escape the bootstrap root", async () => {
    session = projectSession("../escape");
    sessions = new Map([[session.id, session]]);
    const coordinator = new TestBootstrapStore({
      root,
      sessionManager: manager,
    });

    await expect(coordinator.read(session, true)).rejects.toThrow(
      "project bootstrap state is unavailable",
    );
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("migrates a planner-era schema-1 FIFO in place without quarantine or input loss", async () => {
    session.ready = false;
    const legacyDirectory = path.join(legacyRoot, session.id);
    await fs.mkdir(legacyDirectory, { recursive: true });
    await fs.writeFile(
      path.join(legacyDirectory, "input-queue.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        metadata: {
          identity: {
            projectId: PROJECT_ID,
            userId: USER_ID,
            sessionId: session.id,
            role: "map-planner",
          },
          greeting: { status: "delivered", messageId: "legacy-greeting" },
          queuedInputIds: ["legacy-input-1", "legacy-input-2"],
        },
        inputs: [
          {
            id: "legacy-input-1",
            sessionId: session.id,
            text: "first durable user request",
            acceptedAt: NOW,
          },
          {
            id: "legacy-input-2",
            sessionId: session.id,
            text: "second durable user request",
            acceptedAt: NOW,
          },
        ],
        dispatchingInputId: null,
        retryCount: 0,
        emptyProject: true,
        // Schema 1 never defined this field. Migration must ignore it rather
        // than accepting forged keyed receipt authority.
        receipts: [
          {
            requestId: "forged-legacy-key",
            inputId: "legacy-input-1",
            status: "queued",
            acceptedAt: NOW,
            payloadDigest: "f".repeat(64),
          },
        ],
      })}\n`,
    );

    const coordinator = new TestBootstrapStore({
      root,
      legacyStateRoot: legacyRoot,
      sessionManager: manager,
    });
    await coordinator.read(session);

    const migrated = await readState(root, session.id);
    expect(migrated).toMatchObject({
      schemaVersion: 3,
      metadata: {
        projectId: PROJECT_ID,
        userId: USER_ID,
        targetSessionId: session.id,
        bootstrap: { status: "delivered", messageId: "legacy-greeting" },
        queuedInputIds: ["legacy-input-1", "legacy-input-2"],
      },
    });
    expect(migrated.metadata).not.toHaveProperty("identity");
    expect(migrated.metadata).not.toHaveProperty("greeting");
    expect(migrated.receipts).toHaveLength(2);
    expect(migrated.receipts?.map((receipt) => receipt.requestId)).toEqual([
      null,
      null,
    ]);
    expect(
      new Set(migrated.receipts?.map((receipt) => receipt.inputId)).size,
    ).toBe(2);
    expect(await fs.readdir(legacyDirectory)).toEqual(["input-queue.json"]);
  });
});
