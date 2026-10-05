import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startServer, type HarnessServer } from "./index.js";

let root: string | undefined;
let server: HarnessServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it("adding a project pre-trusts its root for Claude Code and nothing else (SAP-3879)", async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "claude-code-trust-wiring-")),
  );
  const stateRoot = path.join(root, "profile");
  const opened = path.join(root, "opened-project");
  await fs.mkdir(stateRoot);
  await fs.mkdir(opened);
  // test-setup.ts gives every file an isolated HOME; Claude Code reads
  // ~/.claude.json there.
  const configFile = path.join(os.homedir(), ".claude.json");
  await fs.writeFile(
    configFile,
    JSON.stringify({ theme: "dark", projects: { "/kept": { a: 1 } } }),
  );
  server = await startServer({
    port: 0,
    bootToken: "test-token",
    telemetryOptIn: false,
    adapters: {},
    availableHarnesses: ["claude-code"],
    stateRoot,
    launchDir: stateRoot,
    projectRoot: path.join(stateRoot, "projects"),
    autoCreateSession: false,
    loadSystemPrompt: async () => "",
  });

  const response = await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Harness-Token": "test-token",
    },
    body: JSON.stringify({ recentDirs: [opened] }),
  });
  expect(response.status).toBe(200);

  await vi.waitFor(
    async () => {
      const config = JSON.parse(await fs.readFile(configFile, "utf8"));
      expect(config).toEqual({
        theme: "dark",
        projects: {
          "/kept": { a: 1 },
          [opened]: { hasTrustDialogAccepted: true },
        },
      });
    },
    { timeout: 10_000 },
  );
}, 20_000);
