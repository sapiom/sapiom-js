import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "../shared/types.js";
import { startServer, type HarnessServer } from "./index.js";

let root: string | undefined;
let server: HarnessServer | undefined;
beforeEach(() => {
  // test-setup.ts gives every file an isolated HOME; these keep Claude Code's
  // config there rather than wherever the developer's shell points it.
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  vi.stubEnv("CLAUDE_CODE_CUSTOM_OAUTH_URL", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await server?.close();
  server = undefined;
  if (root) await fs.rm(root, { recursive: true, force: true });
});

const configFile = () => path.join(os.homedir(), ".claude.json");

const claudeCode: HarnessAdapter = {
  id: "claude-code",
  eventSource: "hooks",
  doctor: async () => [],
  launch: (opts) => ({ command: "bash", args: [], env: {}, cwd: opts.cwd }),
  resume: (_id, opts) => ({ command: "bash", args: [], env: {}, cwd: opts.cwd }),
  listPastSessions: async () => [],
  canResume: async () => true,
};

async function start(recentDirs: string[] = []): Promise<HarnessServer> {
  root ??= await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "claude-code-trust-wiring-")),
  );
  const stateRoot = path.join(root, "profile");
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(path.join(stateRoot, "settings.json"), JSON.stringify({ recentDirs }));
  server = await startServer({
    port: 0,
    bootToken: "test-token",
    telemetryOptIn: false,
    adapters: { "claude-code": claudeCode },
    availableHarnesses: ["claude-code"],
    stateRoot,
    launchDir: stateRoot,
    projectRoot: path.join(stateRoot, "projects"),
    autoCreateSession: false,
    loadSystemPrompt: async () => "",
  });
  return server;
}

function api(
  method: "GET" | "POST" | "PATCH",
  route: string,
  body?: unknown,
  token: string | null = "test-token",
): Promise<Response> {
  return fetch(`http://127.0.0.1:${server!.port}/api${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Harness-Token": token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const status = async (cwd: string) =>
  (await api("GET", `/claude-code-trust?cwd=${encodeURIComponent(cwd)}`)).json();

it("adding a project or starting a Claude Code session in it writes no trust (SAP-4381)", async () => {
  await start();
  const opened = path.join(root!, "opened-project");
  const inside = path.join(opened, "agent");
  await fs.mkdir(inside, { recursive: true });
  const original = JSON.stringify({ theme: "dark", projects: { "/kept": { a: 1 } } });
  await fs.writeFile(configFile(), original);

  expect((await api("PATCH", "/settings", { recentDirs: [opened] })).status).toBe(200);
  // The add-time initialization runs after the response; let it finish.
  await vi.waitFor(async () => expect((await status(inside)).root).toBe(opened));
  await new Promise((done) => setTimeout(done, 300));
  await server!.sessionManager.create({ cwd: inside, harness: "claude-code" });

  expect(await fs.readFile(configFile(), "utf8")).toBe(original);
}, 20_000);

it("reports and writes trust only for an added root, on request (SAP-4381)", async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "claude-code-trust-wiring-")),
  );
  const added = path.join(root, "added-project");
  const inside = path.join(added, "agent");
  const elsewhere = path.join(root, "not-a-project");
  await fs.mkdir(inside, { recursive: true });
  await fs.mkdir(elsewhere);
  await start([added]);
  await fs.writeFile(configFile(), JSON.stringify({ theme: "light", projects: { "/kept": { a: 1 } } }));
  const read = async () => JSON.parse(await fs.readFile(configFile(), "utf8"));

  expect(await status(inside)).toEqual({ root: added, trusted: false, trustable: true });
  expect(await status(elsewhere)).toEqual({ root: null, trusted: false, trustable: false });

  // Not an added root, even inside one: refused, nothing written.
  const before = await fs.readFile(configFile(), "utf8");
  for (const folder of [elsewhere, inside]) {
    const refused = await api("POST", "/claude-code-trust", { root: folder });
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ code: "not_an_added_project" });
  }
  expect(await fs.readFile(configFile(), "utf8")).toBe(before);

  const trusted = await api("POST", "/claude-code-trust", { root: added });
  expect(trusted.status).toBe(200);
  expect(await trusted.json()).toEqual({ result: "trusted" });
  expect(await read()).toEqual({
    theme: "light",
    projects: { "/kept": { a: 1 }, [added]: { hasTrustDialogAccepted: true } },
  });
  expect(await (await api("POST", "/claude-code-trust", { root: added })).json()).toEqual({
    result: "already-trusted",
  });
  expect(await status(inside)).toEqual({ root: added, trusted: true, trustable: false });
}, 20_000);

it("matches an added root by its resolved path, and needs a readable config (SAP-4381)", async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "claude-code-trust-wiring-")),
  );
  const physical = path.join(root, "physical-project");
  const linked = path.join(root, "linked-project");
  await fs.mkdir(physical);
  await fs.symlink(physical, linked);
  await start([linked]);

  // No Claude Code config yet: Studio could not write the record, so it does not offer to.
  await fs.rm(configFile(), { force: true });
  expect(await status(physical)).toEqual({ root: linked, trusted: false, trustable: false });

  await fs.writeFile(configFile(), "{}");
  expect(await status(physical)).toEqual({ root: linked, trusted: false, trustable: true });
}, 20_000);

it("keeps both routes behind the boot token (SAP-4381)", async () => {
  await start();
  expect((await api("GET", "/claude-code-trust?cwd=/tmp", undefined, null)).status).toBe(401);
  expect((await api("POST", "/claude-code-trust", { root: "/tmp" }, null)).status).toBe(401);
}, 20_000);
