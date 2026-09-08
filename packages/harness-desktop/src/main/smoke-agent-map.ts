import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { HARNESS_PATHS } from "@sapiom/harness";
import type { BootResult } from "./boot.js";
import { resolveWebDir } from "./paths.js";

const expand = (path: string): string => join(homedir(), path.slice(2));
async function until(
  label: string,
  predicate: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Agent Map timed out: ${label}`);
}

/** Exercises the shipped SPA/worker and real saved-map APIs, with the smoke
 * runner's isolated home and stub agent. Never imports trial tooling. */
export async function checkAgentMap(boot: BootResult): Promise<string> {
  if (!process.env.SAPIOM_SMOKE_STUB_AGENT)
    return "SKIPPED — run via scripts/smoke.sh for an isolated fixture session";
  const base = `http://127.0.0.1:${boot.server.port}`;
  const cwd = process.env.SAPIOM_LAUNCH_DIR!;
  const web = boot.mainWindow.webContents;
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + "/api" + path, {
      method,
      signal: AbortSignal.timeout(20_000),
      headers: {
        "X-Harness-Token": boot.bootToken,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert(response.ok, `${method} ${path}: ${response.status}`);
    return response.json();
  };
  // Each mutation uses a short-lived, ordinary session capability. The stub
  // exits after three seconds; UI checks need no running agent or inference.
  const propose = async (operations: unknown[]) => {
    const session = await api("/sessions", "POST", {
      cwd,
      harness: "claude-code",
    });
    try {
      const config = JSON.parse(
        await readFile(
          join(expand(HARNESS_PATHS.generated), session.id, "mcp-config.json"),
          "utf8",
        ),
      );
      const entry = config.mcpServers["agent-map"] as {
        url: string;
        headers: Record<string, string>;
      };
      let mcpSession: string | null = null;
      let id = 0;
      const rpc = async (method: string, params: unknown) => {
        const requestId = ++id;
        const response = await fetch(entry.url, {
          method: "POST",
          signal: AbortSignal.timeout(5_000),
          headers: {
            ...entry.headers,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(mcpSession ? { "Mcp-Session-Id": mcpSession } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            method,
            params,
          }),
        });
        assert(response.ok, `Map MCP ${method}: ${response.status}`);
        mcpSession = response.headers.get("mcp-session-id") ?? mcpSession;
        const text = await response.text();
        const message = response.headers
          .get("content-type")
          ?.includes("text/event-stream")
          ? text
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => JSON.parse(line.slice(6)))
              .find((item) => item.id === requestId)
          : JSON.parse(text);
        assert(
          message && !message.error && !message.result?.isError,
          `Map MCP ${method} rejected fixture`,
        );
        return message.result;
      };
      await rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "desktop-map-smoke", version: "1" },
      });
      const current = (
        await rpc("tools/call", { name: "agent_map_read", arguments: {} })
      ).structuredContent;
      await rpc("tools/call", {
        name: "agent_map_propose",
        arguments: {
          schemaVersion: 1,
          proposalId: current.proposal?.proposalId ?? null,
          expectedVersion: current.proposal?.version ?? 0,
          requestId: session.id,
          operations,
        },
      });
      return current.project.projectId as string;
    } finally {
      await api(`/sessions/${session.id}`, "DELETE");
    }
  };
  const node = (name: string, kind = "agent") => ({
    kind: "add-node",
    draftRef: name,
    node: {
      kind,
      name,
      purpose: "Packaged layout verification",
      ownerAgent: null,
      contractRefs: [],
    },
  });
  const projectId = await propose([
    node("Research"),
    node("Report"),
    node("Archive"),
    node("Sources", "resource"),
    node("Document", "artifact"),
    node("Search", "connector"),
    {
      kind: "add-relationship",
      draftRef: "handoff",
      relationship: {
        from: { draftRef: "Research" },
        to: { draftRef: "Report" },
        kind: "feeds",
        executionMode: "asynchronous",
        contractRef: null,
        description: "Research feeds the report",
      },
    },
  ]);
  const snapshot = () =>
    readFile(
      join(
        expand(HARNESS_PATHS.agentMap),
        "projects",
        projectId,
        "workspace.json",
      ),
      "utf8",
    );
  const before = await snapshot();
  const evaluate = <T>(script: string): Promise<T> =>
    web.executeJavaScript(script, true);
  const selector = (id: string) => `[data-testid="${id}"]`;
  const project = selector(`project-select-${basename(cwd)}`);
  const click = async (target: string) => {
    await until(target, () =>
      evaluate(`Boolean(document.querySelector(${JSON.stringify(target)}))`),
    );
    await evaluate(`document.querySelector(${JSON.stringify(target)}).click()`);
  };
  const ready = async (engine: string, state = "ready") =>
    until(`${engine}/${state}`, () =>
      evaluate(`(() => {
    const map = document.querySelector('[data-testid="agent-map-canvas"]');
    return map?.dataset.layoutEngine === ${JSON.stringify(engine)} && map.dataset.layoutState === ${JSON.stringify(state)};
  })()`),
    );
  const mode = (name: string) =>
    evaluate<void>(
      `[...document.querySelectorAll('.agent-map-controls button')].find(b => b.textContent === ${JSON.stringify(name)}).click()`,
    );
  let blockWorker = false;
  const workerUrls = new Set<string>();
  const filter = { urls: ["*://*/*elk-worker.min-*.js*"] };
  web.session.webRequest.onBeforeRequest(filter, (_details, callback) =>
    callback({ cancel: blockWorker }),
  );
  web.session.webRequest.onCompleted(filter, (details) => {
    if (details.statusCode === 200) workerUrls.add(details.url);
  });
  try {
    await boot.mainWindow.loadURL(boot.url);
    await evaluate(`window.__elkTerminations = 0; const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker { terminate() { window.__elkTerminations++; super.terminate(); } };`);
    const coldStart = performance.now();
    await click(project);
    await ready("elk");
    const coldMs = Math.round(performance.now() - coldStart);
    assert(workerUrls.size > 0, "No packaged ELK worker loaded");
    for (const url of workerUrls) assert.equal(new URL(url).origin, base);
    const count = () =>
      evaluate<number>("document.querySelectorAll('.agent-map-node').length");
    assert.equal(await count(), 6);
    await click(".agent-map-node-info");
    await until("inspector", () =>
      evaluate(
        "Boolean(document.querySelector('[data-testid=agent-map-inspector]'))",
      ),
    );
    await click(selector("agent-map-inspector-close"));
    await click('[aria-label="Zoom in"]');
    await evaluate(
      `document.querySelector('[data-testid=agent-map-viewport]').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}))`,
    );
    await click('[aria-label="Fit Agent Map to view"]');
    await click(selector("canvas-expand"));
    await ready("elk");
    if (process.env.SAPIOM_SMOKE_OUT)
      await writeFile(
        `${process.env.SAPIOM_SMOKE_OUT}.agent-map.png`,
        (await web.capturePage()).toPNG(),
      );
    await click(selector("canvas-expand-exit"));
    await mode("Classic");
    await ready("classic");
    await until(
      "saved Classic",
      async () => (await api("/settings")).agentMapLayout === "classic",
    );
    await boot.mainWindow.loadURL(boot.url);
    await click(project);
    await ready("classic");
    // A different origin reproduces desktop's changing port without faking the
    // settings API or launching another copy of the user's desktop app.
    const otherOrigin = new URL(boot.url);
    otherOrigin.hostname = "localhost";
    await boot.mainWindow.loadURL(otherOrigin.toString());
    await click(project);
    await ready("classic");
    await boot.mainWindow.loadURL(boot.url);
    await click(project);
    await ready("classic");
    blockWorker = true;
    await mode("Vertical");
    await ready("classic", "fallback");
    assert(
      await evaluate<boolean>(
        "document.querySelector('.agent-map-controls').textContent.includes('Classic fallback')",
      ),
    );
    blockWorker = false;
    await mode("Classic");
    await ready("classic");
    const warmStart = performance.now();
    await mode("Vertical");
    await ready("elk");
    const warmMs = Math.round(performance.now() - warmStart);
    assert.equal(await snapshot(), before, "Viewing changed saved map/history");
    await propose([node("Follow-up")]);
    await until("live map update", async () => (await count()) === 7);
    await ready("elk");
    const updated = await snapshot();
    await evaluate(`window.__elkTerminations = 0; const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker { terminate() { window.__elkTerminations++; super.terminate(); } };`);
    // Remount so the instrumentation owns this canvas's worker, then navigate
    // to the other project created by the existing session-create smoke check.
    await mode("Classic");
    await ready("classic");
    const otherProject = `[data-testid^="project-select-"]:not(${project})`;
    await click(otherProject);
    await click(project);
    await mode("Vertical");
    await ready("elk");
    await click(otherProject);
    await until("worker disposal", () =>
      evaluate("window.__elkTerminations > 0"),
    );
    assert.equal(
      await snapshot(),
      updated,
      "Navigation changed saved map/history",
    );
    const assets = join(resolveWebDir(), "assets");
    const workerFile = (await readdir(assets)).find((name) =>
      /^elk-worker\.min-.*\.js$/.test(name),
    );
    assert(workerFile, "No worker asset in package");
    const bytes = await readFile(join(assets, workerFile));
    return (
      `Vertical default, durable Classic across origins, fallback/recovery, live update and disposal; ` +
      `map/history unchanged by views; worker ${bytes.length}B (${gzipSync(bytes).length}B gzip); UI ready cold ${coldMs}ms, warm ${warmMs}ms`
    );
  } finally {
    web.session.webRequest.onBeforeRequest(filter, null);
    web.session.webRequest.onCompleted(filter, null);
  }
}
