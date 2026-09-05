import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  startOpenCodeStandalone,
  type OpenCodeStandalone,
} from "./standalone.js";

const fixture = fileURLToPath(
  new URL("./__fixtures__/fake-opencode.mjs", import.meta.url),
);

const liveApps = new Set<OpenCodeStandalone>();

afterEach(async () => {
  await Promise.all([...liveApps].map((app) => app.close()));
  liveApps.clear();
});

describe("startOpenCodeStandalone", () => {
  it("serves the UI and proxies OpenCode without exposing its credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "sapiom-opencode-app-test-"));
    const cwd = join(root, "project");
    const webRoot = join(root, "web");
    await Promise.all([mkdir(cwd), mkdir(webRoot)]);
    await writeFile(join(webRoot, "index.html"), "<h1>POC ready</h1>");

    const app = await startOpenCodeStandalone({
      command: {
        executable: process.execPath,
        prefixArgs: [fixture],
      },
      cwd,
      stateRoot: join(root, "state"),
      webRoot,
    });
    liveApps.add(app);

    const page = await fetch(app.origin);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("POC ready");

    const health = await fetch(`${app.origin}/opencode/global/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      healthy: true,
      version: "fake-opencode",
    });

    const events = await fetch(`${app.origin}/opencode/global/event`);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    expect(await events.text()).toContain("server.connected");

    const compressed = await fetch(`${app.origin}/opencode/debug/compressed`);
    expect(compressed.headers.get("content-encoding")).toBeNull();
    expect(compressed.headers.get("content-length")).toBeNull();
    expect(await compressed.json()).toEqual({ compressed: true });

    const pid = app.opencode.pid;
    await app.close();
    await app.close();
    liveApps.delete(app);

    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("does not allow static paths to escape the web root", async () => {
    const root = await mkdtemp(join(tmpdir(), "sapiom-opencode-app-test-"));
    const cwd = join(root, "project");
    const webRoot = join(root, "web");
    await Promise.all([mkdir(cwd), mkdir(webRoot)]);
    await writeFile(join(webRoot, "index.html"), "safe");
    await writeFile(join(root, "secret.txt"), "must not leak");

    const app = await startOpenCodeStandalone({
      command: {
        executable: process.execPath,
        prefixArgs: [fixture],
      },
      cwd,
      stateRoot: join(root, "state"),
      webRoot,
    });
    liveApps.add(app);

    const response = await fetch(`${app.origin}/..%2Fsecret.txt`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("must not leak");
  });
});
