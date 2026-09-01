import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HarnessAdapter,
  LaunchOpts,
  SpawnSpec,
} from "../shared/types.js";
import { startServer, type HarnessServer } from "./index.js";

const BOOT_TOKEN = "trusted-host-token";

function tokenCapturingAdapter(
  tokenPath: string | ((sessionId: string) => string),
): HarnessAdapter {
  const launch = (opts: LaunchOpts): SpawnSpec => ({
    command: "bash",
    args: [
      "-c",
      'printf \'{"ingestUrl":"%s","ingestToken":"%s"}\' "$SAPIOM_HARNESS_INGEST_URL" "$SAPIOM_HARNESS_INGEST_TOKEN" > "$SAPIOM_TEST_INGEST_TOKEN_PATH"; exec bash',
    ],
    env: {
      SAPIOM_TEST_INGEST_TOKEN_PATH:
        typeof tokenPath === "string"
          ? tokenPath
          : tokenPath(opts.harnessSessionId),
    },
    cwd: opts.cwd,
  });
  return {
    id: "claude-code",
    eventSource: "hooks",
    doctor: async () => [],
    launch,
    resume: (_agentSessionId, opts) => launch(opts),
    listPastSessions: async () => [],
    canResume: async () => true,
  };
}

async function unusedPort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

describe("coding-agent authorization boundary", () => {
  let root: string;
  let projectRoot: string;
  let tokenPath: string;
  let webDir: string;
  let server: HarnessServer | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-map-auth-wiring-"));
    projectRoot = path.join(root, "project");
    tokenPath = path.join(root, "ingest-token");
    webDir = path.join(root, "web");
    await fs.mkdir(projectRoot);
    await fs.mkdir(webDir);
    await fs.writeFile(
      path.join(webDir, "index.html"),
      '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    );
  });

  afterEach(async () => {
    await server?.sessionManager.flush();
    await server?.close();
    await server?.sessionManager.flush();
    server = undefined;
    // Session exit schedules generated-dir cleanup. Retry if that bounded
    // removal overlaps this fixture's own recursive cleanup.
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });

  it("allows the PTY token to ingest hooks but rejects it on project mutations", async () => {
    const port = await unusedPort();
    server = await startServer({
      port,
      bootToken: BOOT_TOKEN,
      telemetryOptIn: false,
      adapters: { "claude-code": tokenCapturingAdapter(tokenPath) },
      stateRoot: root,
      launchDir: projectRoot,
      webDir,
      autoCreateSession: false,
      loadSystemPrompt: async () => "",
    });
    const session = await server.sessionManager.create({
      cwd: projectRoot,
      harness: "claude-code",
    });
    let ptyEnvironment: { ingestUrl: string; ingestToken: string } | undefined;
    await vi.waitFor(async () => {
      ptyEnvironment = JSON.parse(await fs.readFile(tokenPath, "utf8")) as {
        ingestUrl: string;
        ingestToken: string;
      };
      expect(ptyEnvironment.ingestToken).not.toBe("");
    });

    const { ingestToken, ingestUrl } = ptyEnvironment!;
    expect(ingestToken).not.toBe(BOOT_TOKEN);
    expect(JSON.stringify(ptyEnvironment)).not.toContain(server.uiToken);
    const baseUrl = new URL(ingestUrl).origin;
    expect(baseUrl).toBe(`http://127.0.0.1:${server.port}`);

    // The model can fetch the origin it receives for hooks, but without the
    // host-only UI launch capability the HTML contains no privileged token.
    const bareHtml = await (await fetch(`${baseUrl}/`)).text();
    expect(bareHtml).not.toContain(BOOT_TOKEN);
    expect(bareHtml).not.toContain(server.uiToken);
    const mutation = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Harness-Token": ingestToken,
      },
      body: JSON.stringify({ displayName: "Model-controlled project" }),
    });
    expect(mutation.status).toBe(401);

    const forgedPlanner = await fetch(
      `${baseUrl}/api/projects/forged-project/planner-sessions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Harness-Token": ingestToken,
        },
        body: JSON.stringify({ mode: "fresh" }),
      },
    );
    expect(forgedPlanner.status).toBe(401);

    const forgedGenericRole = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Harness-Token": ingestToken,
      },
      body: JSON.stringify({
        cwd: projectRoot,
        harness: "claude-code",
        planning: {
          identity: {
            projectId: "forged-project",
            sessionId: "forged-session",
            userId: "forged-user",
            role: "map-planner",
          },
        },
      }),
    });
    expect(forgedGenericRole.status).toBe(401);

    const legitimateLaunch = await fetch(
      `${baseUrl}/?uiToken=${encodeURIComponent(server.uiToken)}`,
      { redirect: "manual" },
    );
    expect(legitimateLaunch.status).toBe(303);
    expect(legitimateLaunch.headers.get("location")).not.toContain("uiToken");
    const uiCookie = legitimateLaunch.headers
      .get("set-cookie")
      ?.split(";", 1)[0];
    const legitimateHtml = await (
      await fetch(`${baseUrl}${legitimateLaunch.headers.get("location")!}`, {
        headers: { cookie: uiCookie! },
      })
    ).text();
    expect(legitimateHtml).toContain(JSON.stringify(BOOT_TOKEN));

    const bootTokenIngest = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${BOOT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        hookEvent: "SessionStart",
        harnessSessionId: session.id,
        payload: { session_id: "agent-wrong-token" },
      }),
    });
    expect(bootTokenIngest.status).toBe(401);

    const ingest = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ingestToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        hookEvent: "SessionStart",
        harnessSessionId: session.id,
        payload: { session_id: "agent-ingest-only", source: "startup" },
      }),
    });
    expect(ingest.status).toBe(200);
    await vi.waitFor(() => {
      expect(server?.sessionManager.get(session.id)?.agentSessionId).toBe(
        "agent-ingest-only",
      );
    });

    await server.sessionManager.kill(session.id);
    const afterExit = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ingestToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        hookEvent: "SessionStart",
        harnessSessionId: session.id,
        payload: { session_id: "replayed-after-exit" },
      }),
    });
    expect(afterExit.status).toBe(401);
  });

  it("rejects one PTY capability when it forges another session id", async () => {
    const tokenFor = (sessionId: string) => path.join(root, `${sessionId}.token`);
    server = await startServer({
      port: 0,
      bootToken: BOOT_TOKEN,
      telemetryOptIn: false,
      adapters: { "claude-code": tokenCapturingAdapter(tokenFor) },
      stateRoot: root,
      launchDir: projectRoot,
      autoCreateSession: false,
      loadSystemPrompt: async () => "",
    });
    const first = await server.sessionManager.create({
      cwd: projectRoot,
      harness: "claude-code",
    });
    const second = await server.sessionManager.create({
      cwd: projectRoot,
      harness: "claude-code",
    });
    let firstToken = "";
    let secondToken = "";
    await vi.waitFor(async () => {
      firstToken = await fs.readFile(tokenFor(first.id), "utf8");
      secondToken = await fs.readFile(tokenFor(second.id), "utf8");
      expect(firstToken).not.toBe("");
      expect(secondToken).not.toBe("");
    });
    expect(firstToken).not.toBe(secondToken);

    const baseUrl = `http://127.0.0.1:${server.port}`;
    const forged = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${firstToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        hookEvent: "SessionStart",
        harnessSessionId: second.id,
        payload: { session_id: "forged-agent-session" },
      }),
    });
    expect(forged.status).toBe(401);
    expect(server.sessionManager.get(second.id)?.agentSessionId).toBeNull();

    const owned = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secondToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        hookEvent: "SessionStart",
        harnessSessionId: second.id,
        payload: { session_id: "owned-agent-session", source: "startup" },
      }),
    });
    expect(owned.status).toBe(200);
    await vi.waitFor(() => {
      expect(server?.sessionManager.get(second.id)?.agentSessionId).toBe(
        "owned-agent-session",
      );
    });
  });
});
