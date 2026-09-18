import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { STUDIO_HOST_CONTEXT_ENV } from "@sapiom/agent-map/host-protocol";
import { StudioProjectCatalog } from "@sapiom/agent-map/node/studio-project-catalog";
import {
  mcpCommandForEntry,
  prepareBundledMcpCommand,
  qualifyMcpCommand,
} from "../core/mcp-compatibility.js";
import type {
  HarnessAdapter,
  HarnessKind,
  LaunchOpts,
  SpawnSpec,
} from "../shared/types.js";
import { startServer, type HarnessServer } from "./index.js";

const descriptor = {
  descriptorVersion: 1,
  packageName: "@sapiom/mcp",
  packageVersion: "1.2.3",
  artifactHash: "a".repeat(64),
  hostProtocolVersions: [1],
  mapSchemaVersions: [1],
  features: ["studio-context"],
};
let root: string;
let server: HarnessServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});
async function fixture(
  kind: HarnessKind = "claude-code",
  legacy = false,
  cli = false,
) {
  root = await mkdtemp(join(tmpdir(), "mcp-launch-"));
  const project = join(root, "project");
  const web = join(root, "web");
  const mcp = join(root, "mcp");
  await Promise.all([
    mkdir(project),
    mkdir(web),
    mkdir(join(mcp, "dist"), { recursive: true }),
  ]);
  await writeFile(join(web, "index.html"), "<html></html>");
  const pkg = {
    name: "@sapiom/mcp",
    type: "module",
    version: "1.2.3",
    bin: { "sapiom-mcp": "dist/index.js" },
    ...(legacy ? {} : { sapiomCapabilities: 1 }),
  };
  await writeFile(join(mcp, "package.json"), JSON.stringify(pkg));
  const entry = join(mcp, "dist/index.js");
  await writeFile(
    entry,
    `console.log(${JSON.stringify(JSON.stringify(descriptor))})`,
  );
  await new StudioProjectCatalog(join(root, "studio-projects.json")).reconcile([
    { workspaceKey: "project", cwd: project },
  ]);
  const launches: LaunchOpts[] = [];
  const launch = (opts: LaunchOpts): SpawnSpec => {
    launches.push(opts);
    return {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: {},
      cwd: opts.cwd,
    };
  };
  const adapter: HarnessAdapter = {
    id: kind,
    eventSource: "hooks",
    doctor: async () => [],
    launch,
    resume: (_id, opts) => launch(opts),
    canResume: async () => true,
    listPastSessions: async () => [],
  };
  const command = mcpCommandForEntry(entry);
  const prepare = vi.fn(() =>
    cli ? prepareBundledMcpCommand(command) : qualifyMcpCommand(command),
  );
  server = await startServer({
    port: 0,
    bootToken: "boot",
    telemetryOptIn: false,
    identity: null,
    machineId: "machine",
    adapters: { [kind]: adapter },
    stateRoot: root,
    webDir: web,
    launchDir: project,
    autoCreateSession: false,
    prepareSapiomDevMcp: prepare,
    loadSystemPrompt: async () => {
      expect(prepare).toHaveBeenCalled();
      return "coding prompt";
    },
  });
  const session = await server.sessionManager.create({
    cwd: project,
    harness: kind,
  });
  const config = async () =>
    JSON.parse(await readFile(launches.at(-1)!.mcpConfigFile!, "utf8"));
  return { entry, command, prepare, session, launches, config };
}

it.each<HarnessKind>(["claude-code", "codex"])(
  "carries the qualified command and rotates context on %s resume",
  async (kind) => {
    const f = await fixture(kind);
    const first = await f.config();
    const dev = first.mcpServers["sapiom-dev"];
    expect({ command: dev.command, args: dev.args }).toEqual(f.command);
    const bootstrap = JSON.parse(dev.env[STUDIO_HOST_CONTEXT_ENV]);
    expect(bootstrap.expectedMcp).toEqual(descriptor);
    expect(bootstrap.bearerToken).toBe(f.launches[0]!.agentMapMcp!.bearerToken);
    const request = (token: string) =>
      fetch(bootstrap.contextUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
    expect((await request(bootstrap.bearerToken)).status).toBe(200);
    expect(first.mcpServers["agent-map"]).toBeDefined();
    expect(await readFile(f.launches[0]!.systemPromptFile!, "utf8")).toContain(
      "agent_map_read",
    );
    await server!.sessionManager.setAgentSessionId(
      f.session.id,
      "provider-session",
    );
    await server!.sessionManager.kill(f.session.id);
    await server!.sessionManager.resume(f.session.id);
    expect(f.prepare).toHaveBeenCalledTimes(2);
    const resumed = JSON.parse(
      (await f.config()).mcpServers["sapiom-dev"].env[STUDIO_HOST_CONTEXT_ENV],
    );
    expect(resumed.bearerToken).not.toBe(bootstrap.bearerToken);
    expect((await request(bootstrap.bearerToken)).status).toBe(401);
    expect(await (await request(resumed.bearerToken)).json()).toMatchObject({
      generation: 2,
    });
  },
);

it("requalifies rollback at resume and retains the private map configuration", async () => {
  const f = await fixture();
  await server!.sessionManager.setAgentSessionId(
    f.session.id,
    "provider-session",
  );
  await server!.sessionManager.kill(f.session.id);
  const pkg = JSON.parse(
    await readFile(join(root, "mcp/package.json"), "utf8"),
  );
  delete pkg.sapiomCapabilities;
  await writeFile(join(root, "mcp/package.json"), JSON.stringify(pkg));
  await server!.sessionManager.resume(f.session.id);
  const config = await f.config();
  expect(config.mcpServers["sapiom-dev"].args).toEqual(f.command.args);
  expect(
    config.mcpServers["sapiom-dev"].env[STUDIO_HOST_CONTEXT_ENV],
  ).toBeUndefined();
  expect(config.mcpServers["agent-map"]).toBeDefined();
});

it("keeps CLI's latest fallback unqualified when its dependency is old or unbuilt", async () => {
  const f = await fixture("claude-code", true, true);
  expect(await prepareBundledMcpCommand(f.command)).toBeUndefined();
  await rm(f.entry);
  expect(await prepareBundledMcpCommand(f.command)).toBeUndefined();
  const config = await f.config();
  expect(config.mcpServers["sapiom-dev"].command).toBe("npx");
  expect(config.mcpServers["sapiom-dev"].args).toEqual([
    "-y",
    "@sapiom/mcp@latest",
  ]);
  expect(config.mcpServers["agent-map"]).toBeDefined();
  expect(
    config.mcpServers["sapiom-dev"].env[STUDIO_HOST_CONTEXT_ENV],
  ).toBeUndefined();
});

it("keeps private tools and matching prompts when preflight fails on resume", async () => {
  const f = await fixture();
  await server!.sessionManager.setAgentSessionId(
    f.session.id,
    "provider-session",
  );
  await server!.sessionManager.kill(f.session.id);
  f.prepare.mockRejectedValueOnce(new Error("offline/failed preparation"));
  await server!.sessionManager.resume(f.session.id);
  const config = await f.config();
  expect(config.mcpServers["sapiom-dev"].command).toBe("npx");
  expect(
    config.mcpServers["sapiom-dev"].env[STUDIO_HOST_CONTEXT_ENV],
  ).toBeUndefined();
  expect(config.mcpServers["agent-map"]).toBeDefined();
  expect(
    await readFile(f.launches.at(-1)!.systemPromptFile!, "utf8"),
  ).toContain("agent_map_read");
});

it("retains a fresh project's scope through preflight when cwd is a filesystem alias", async () => {
  const f = await fixture();
  const project = join(root, "fresh-project");
  const alias = join(root, "alias");
  await mkdir(project);
  await symlink(project, alias, "junction");
  f.prepare.mockImplementationOnce(async () => {
    // The UI reconciles the catalog while an offline probe is pending. macOS
    // /var aliases and Windows short temp paths must retain the canonical root.
    const response = await fetch(`http://127.0.0.1:${server!.port}/api/state`, {
      headers: { "X-Harness-Token": "boot" },
    });
    expect(response.status).toBe(200);
    return qualifyMcpCommand(f.command);
  });
  const session = await server!.sessionManager.create({
    cwd: alias,
    harness: "claude-code",
  });
  const identity = await new StudioProjectCatalog(
    join(root, "studio-projects.json"),
  ).resolveIdentityForPath(project);
  expect(session.agentMapIdentity).toBeDefined();
  expect(identity).not.toBeNull();
  expect(session.agentMapIdentity?.projectId).toBe(identity?.projectId);
  expect(session.status).toBe("running");
});
