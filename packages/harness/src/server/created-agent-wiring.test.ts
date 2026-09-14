import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type {
  AppState,
  BusMessage,
  HarnessAdapter,
  LaunchOpts,
  SpawnSpec,
} from "../shared/types.js";
import { startServer, type HarnessServer } from "./index.js";

let root: string | undefined;
let server: HarnessServer | undefined;
let socket: WebSocket | undefined;
afterEach(async () => {
  socket?.close();
  await server?.close();
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
});

it(
  "publishes a scaffolded sibling immediately, preserves the conversation, and restores membership on restart",
  { timeout: 25_000 },
  async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "created-agent-wiring-")),
    );
    const stateRoot = path.join(root, "state");
    const projectRoot = path.join(root, "original");
    const reviewer = path.join(root, "reviewer");
    const unrelated = path.join(root, "unrelated");
    const tokenPath = path.join(root, "test-ingest-token");
    await fs.mkdir(stateRoot);
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "sapiom.json"), "{}");
    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ name: "original" }),
    );
    await fs.writeFile(
      path.join(stateRoot, "settings.json"),
      JSON.stringify({ recentDirs: [projectRoot] }),
    );
    const launch = (opts: LaunchOpts): SpawnSpec => ({
      command: process.execPath,
      args: [
        "-e",
        "require('fs').writeFileSync(process.env.SAPIOM_TEST_TOKEN_PATH, process.env.SAPIOM_HARNESS_INGEST_TOKEN); setInterval(() => {}, 1000)",
      ],
      cwd: opts.cwd,
      env: { SAPIOM_TEST_TOKEN_PATH: tokenPath },
    });
    const adapter: HarnessAdapter = {
      id: "claude-code",
      eventSource: "hooks",
      doctor: async () => [],
      launch,
      resume: (_id, opts) => launch(opts),
      listPastSessions: async () => [],
      canResume: async () => true,
    };
    const start = () =>
      startServer({
        port: 0,
        bootToken: "test-token",
        telemetryOptIn: false,
        stateRoot,
        launchDir: projectRoot,
        adapters: { "claude-code": adapter },
        autoCreateSession: false,
        loadSystemPrompt: async () => "",
        machineId: "test-machine",
        authMode: "disabled",
      });
    const headers = {
      "X-Harness-Token": "test-token",
      "Content-Type": "application/json",
    };
    server = await start();
    const state = async (): Promise<AppState> =>
      (
        await fetch(`http://127.0.0.1:${server!.port}/api/state`, { headers })
      ).json() as Promise<AppState>;
    const session = await server.sessionManager.create({
      cwd: projectRoot,
      harness: "claude-code",
    });
    const projectId = session.agentMapIdentity!.projectId;
    let token = "";
    await vi.waitFor(async () => {
      token = await fs.readFile(tokenPath, "utf8");
      expect(token).not.toBe("");
    });
    const started = await fetch(`http://127.0.0.1:${server.port}/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        hookEvent: "SessionStart",
        harnessSessionId: session.id,
        payload: {
          session_id: "original-claude-conversation",
          source: "startup",
        },
      }),
    });
    expect(started.status).toBe(200);
    socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/ws/events?token=test-token`,
    );
    await new Promise<void>((resolve, reject) => {
      socket!.once("open", resolve);
      socket!.once("error", reject);
    });
    let changed = 0;
    socket.on("message", (raw) => {
      if (
        (JSON.parse(raw.toString()) as BusMessage).type === "workflows.changed"
      )
        changed++;
    });
    for (const dir of [reviewer, unrelated]) {
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, "sapiom.json"), "{}");
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: path.basename(dir) }),
      );
    }
    const response = await fetch(`http://127.0.0.1:${server.port}/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        hookEvent: "PostToolUse",
        harnessSessionId: session.id,
        payload: {
          session_id: "original-claude-conversation",
          tool_name: "mcp__sapiom-dev__sapiom_dev_agents_scaffold",
          tool_input: { dir: reviewer },
          tool_response: [
            {
              type: "text",
              text: JSON.stringify({
                targetDir: reviewer,
                projectName: "reviewer",
                template: "default",
                gitInitialized: true,
                dependenciesInstalled: true,
              }),
            },
          ],
        },
      }),
    });
    expect(response.status).toBe(200);
    await vi.waitFor(
      async () => {
        const current = await state();
        expect(
          current.workflows.find((workflow) => workflow.path === reviewer)
            ?.studioBindings,
        ).toMatchObject([{ projectId }]);
        expect(
          current.workflows.some((workflow) => workflow.path === unrelated),
        ).toBe(false);
        expect(current.studioProjects).toHaveLength(1);
        expect(current.sessions.map((value) => value.id)).toEqual([session.id]);
        expect(current.sessions[0]?.agentSessionId).toBe(
          "original-claude-conversation",
        );
        expect(changed).toBeGreaterThan(0);
      },
      { timeout: 8_000 },
    );
    const binding = (await state()).workflows.find(
      (workflow) => workflow.path === reviewer,
    )!.studioBindings![0]!;
    const selection = await fetch(
      `http://127.0.0.1:${server.port}/api/projects/${projectId}/current-workspace`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ selection: { kind: "agent", ...binding } }),
      },
    );
    expect(selection.status).toBe(200);
    expect(await selection.json()).toMatchObject({
      selection: { kind: "agent", ...binding },
    });
    socket.close();
    await server.close();
    server = await start();
    expect(
      (await state()).workflows.find((workflow) => workflow.path === reviewer)
        ?.studioBindings,
    ).toEqual([binding]);
    expect((await state()).studioProjects).toHaveLength(1);
    // The exact sibling watcher remains alive without resuming its old session.
    await fs.unlink(path.join(reviewer, "sapiom.json"));
    await vi.waitFor(
      async () => {
        expect(
          (await state()).workflows.some(
            (workflow) => workflow.path === reviewer,
          ),
        ).toBe(false);
      },
      { timeout: 8_000 },
    );
  },
);
