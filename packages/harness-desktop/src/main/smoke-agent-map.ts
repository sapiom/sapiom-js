import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
          proposalId: current.proposal?.id ?? null,
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
  // Hydrate both roots when the SPA loads. Settings written outside the UI
  // are not reflected in its cached settings until a reload.
  const otherRoot = await realpath(
    await mkdtemp(join(dirname(cwd), "map-disposal-")),
  );
  await api("/settings", "PATCH", {
    recentDirs: [...(await api("/settings")).recentDirs, otherRoot],
  });
  const otherSession = await api("/sessions", "POST", {
    cwd: otherRoot,
    harness: "claude-code",
  });
  await api(`/sessions/${otherSession.id}`, "DELETE");
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
  let blockWorker = false;
  const workerUrls = new Set<string>();
  const legacyRequests = { read: 0, refresh: 0, navigation: 0 };
  const filter = {
    urls: [
      "*://*/*elk-worker.min-*.js*",
      "*://*/api/workspaces/*/system-graph*",
    ],
  };
  web.session.webRequest.onBeforeRequest(filter, (details, callback) => {
    const pathname = new URL(details.url).pathname;
    if (pathname.includes("/system-graph")) {
      const kind = pathname.endsWith("/navigation")
        ? "navigation"
        : pathname.endsWith("/refresh")
          ? "refresh"
          : "read";
      legacyRequests[kind]++;
      callback({});
    } else callback({ cancel: blockWorker });
  });
  web.session.webRequest.onCompleted(filter, (details) => {
    if (details.statusCode === 200 && details.url.includes("elk-worker.min-"))
      workerUrls.add(details.url);
  });
  try {
    await boot.mainWindow.loadURL(boot.url);
    if ((await api("/settings")).helpSeen !== true) {
      await click(selector("help-overlay-close"));
      await until(
        "dismissed welcome",
        async () => (await api("/settings")).helpSeen === true,
      );
    }
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
    // Let the 150ms viewport debounce submit the expanded layout before capture.
    await delay(250);
    await ready("elk");
    if (process.env.SAPIOM_SMOKE_OUT)
      await writeFile(
        `${process.env.SAPIOM_SMOKE_OUT}.agent-map.png`,
        (await web.capturePage()).toPNG(),
      );
    await click(selector("canvas-expand-exit"));
    assert.equal(
      await evaluate<number>(
        `[...document.querySelectorAll('.agent-map-controls button')].filter(b => /^(Classic|Vertical)$/.test(b.textContent)).length`,
      ),
      0,
      "Obsolete layout selector is still present",
    );
    await evaluate(
      `localStorage.setItem('sapiom-agent-map-layout', 'classic')`,
    );
    const oldLink = new URL(boot.url);
    oldLink.searchParams.set("mapLayout", "classic");
    await boot.mainWindow.loadURL(oldLink.toString());
    await click(project);
    await ready("elk");
    // Desktop changes its origin between launches; neither old links nor
    // origin-scoped preferences may restore the previous layout.
    const otherOrigin = new URL(oldLink);
    otherOrigin.hostname = "localhost";
    await boot.mainWindow.loadURL(otherOrigin.toString());
    await click(project);
    await ready("elk");
    blockWorker = true;
    await boot.mainWindow.loadURL(boot.url);
    await click(project);
    await ready("elk", "error");
    await until("retryable layout error", () =>
      evaluate(
        `Boolean(document.querySelector('[data-testid=agent-map-layout-error]'))`,
      ),
    );
    assert.equal(
      await count(),
      0,
      "A failed worker rendered a substitute layout",
    );
    blockWorker = false;
    const warmStart = performance.now();
    await click("[data-testid=agent-map-layout-error] button");
    await ready("elk");
    const warmMs = Math.round(performance.now() - warmStart);
    assert.equal(await snapshot(), before, "Viewing changed saved map/history");
    await propose([node("Follow-up")]);
    await until("live map update", async () => (await count()) === 7);
    await ready("elk");
    const updated = await snapshot();
    await evaluate(`(() => {
      const terminate = Worker.prototype.terminate;
      Worker.prototype.terminate = function() { window.__elkTerminations++; return terminate.call(this); };
    })()`);
    const otherProject = selector(`project-select-${basename(otherRoot)}`);
    await ready("elk");
    await evaluate("window.__elkTerminations = 0");
    await click(otherProject);
    await until("left saved map", () =>
      evaluate(
        `document.querySelector('[data-testid=agent-map-live]')?.dataset.projectId !== ${JSON.stringify(projectId)}`,
      ),
    );
    await until("worker disposal", () =>
      evaluate("window.__elkTerminations > 0"),
    );
    assert.equal(
      await snapshot(),
      updated,
      "Navigation changed saved map/history",
    );
    assert.deepEqual(
      legacyRequests,
      { read: 0, refresh: 0, navigation: 0 },
      "Packaged Studio requested legacy project topology",
    );
    // Stale tabs cannot reactivate a graph watcher, even by asking directly.
    const { workspaceScopes } = await api("/state");
    assert(workspaceScopes.length > 0, "No scope for legacy rejection check");
    for (const [suffix, method] of [
      ["", "GET"],
      ["/refresh", "POST"],
      ["/navigation", "GET"],
    ]) {
      const response = await fetch(
        `${base}/api/workspaces/${workspaceScopes[0].workspaceKey}/system-graph${suffix}`,
        {
          method,
          headers: { "X-Harness-Token": boot.bootToken },
          signal: AbortSignal.timeout(5_000),
        },
      );
      assert.equal(
        response.status,
        404,
        `Legacy graph ${method} ${suffix}: expected 404, received ${response.status}`,
      );
    }
    const assets = join(resolveWebDir(), "assets");
    const workerFile = (await readdir(assets)).find((name) =>
      /^elk-worker\.min-.*\.js$/.test(name),
    );
    assert(workerFile, "No worker asset in package");
    const bytes = await readFile(join(assets, workerFile));
    return (
      `Vertical only across origins, ignored old preferences/links, retry/recovery, live update and disposal; ` +
      `legacy reads/refreshes/navigation 0/0/0; direct legacy requests 404; ` +
      `map/history unchanged by views; worker ${bytes.length}B (${gzipSync(bytes).length}B gzip); UI ready cold ${coldMs}ms, warm ${warmMs}ms`
    );
  } finally {
    web.session.webRequest.onBeforeRequest(filter, null);
    web.session.webRequest.onCompleted(filter, null);
  }
}
