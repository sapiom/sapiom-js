import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { query as agentSdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";

import {
  FIXTURE_PATHS,
  createManagedAgentFixture,
  fixturePathExists,
  waitForManagedAgentFixturePids,
} from "./fixture.js";
import { MANAGED_AGENT_CONTRACT } from "./contract.js";
import {
  LocalManagedAgentProcessObserver,
  managedAgentPosixSessionColumn,
  parseManagedAgentPosixProcessTable,
  type ManagedAgentKernelProcessTable,
  type ManagedAgentProcessTableObservation,
} from "./process-observer.js";
import {
  qualifiedManagedAgentMcpToolName,
  runManagedAgentProbe,
} from "./runtime.js";
import type { ManagedAgentProcessObserver } from "./types.js";

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXECUTION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MODEL_ALIAS = "claude-sonnet-5-anthropic-anthropic-eval";
const EVAL_SOURCE =
  "studio-managed-agent-e0-l1-sonnet-5-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CORRELATION_MARKER = `SAPIOM_CERTIFICATION_CORRELATION_V1;eval_source=${EVAL_SOURCE};execution_id=${EXECUTION_ID}`;
const ALLOWED_BASH_COMMAND = "git status --short";
const DENIED_BASH_COMMAND = "touch denied-side-effect.txt";
const ECHO_NONCE_TOOL = qualifiedManagedAgentMcpToolName("echo_nonce");
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

async function readLoopbackProcessTable(): Promise<ManagedAgentProcessTableObservation> {
  try {
    const sessionColumn = managedAgentPosixSessionColumn(process.platform);
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-axo", `pid=,ppid=,pgid=,${sessionColumn}=,stat=,lstart=`],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 1_000 },
    );
    return {
      available: true,
      processes: parseManagedAgentPosixProcessTable(stdout),
    };
  } catch {
    return { available: false };
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessDeath(
  pid: number,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  if (processExists(pid))
    throw new Error(`Test process ${pid} survived cleanup`);
}

function spawnCooperativeUnrelatedProcess(): ChildProcess {
  return spawn(
    process.execPath,
    [
      "-e",
      'process.on("disconnect", () => process.exit(0)); setInterval(() => {}, 1000)',
    ],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    },
  );
}

async function stopCooperativeUnrelatedProcess(
  child: ChildProcess,
): Promise<void> {
  if (typeof child.pid !== "number") return;
  const pid = child.pid;
  if (child.exitCode === null && child.signalCode === null) {
    if (!child.connected) {
      throw new Error(
        `Refusing cleanup for unrelated process ${pid} without retained IPC`,
      );
    }
    child.disconnect();
  }
  await waitForProcessDeath(pid);
}

interface LoopbackObservation {
  readonly headerNames: readonly string[];
  readonly evalSourceMatches: boolean;
  readonly executionIdMatches: boolean;
  readonly promptMarkerPresent: boolean;
  readonly mcpResultMatches: boolean;
}

function containsExactText(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) {
    return value.some((entry) => containsExactText(entry, expected));
  }
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((entry) =>
    containsExactText(entry, expected),
  );
}

function hasSuccessfulMcpResult(body: string, expectedNonce: string): boolean {
  try {
    const payload = JSON.parse(body) as { messages?: unknown };
    if (!Array.isArray(payload.messages)) return false;
    return payload.messages.some((message) => {
      if (typeof message !== "object" || message === null) return false;
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) return false;
      return content.some((block) => {
        if (typeof block !== "object" || block === null) return false;
        const result = block as Record<string, unknown>;
        return (
          result.type === "tool_result" &&
          result.tool_use_id === "toolu_loopback_mcp_echo" &&
          result.is_error !== true &&
          containsExactText(result.content, expectedNonce)
        );
      });
    });
  } catch {
    return false;
  }
}

function hasToolResult(
  body: string,
  toolUseId: string,
  expectedError: boolean,
): boolean {
  try {
    const payload = JSON.parse(body) as { messages?: unknown };
    if (!Array.isArray(payload.messages)) return false;
    return payload.messages.some((message) => {
      if (typeof message !== "object" || message === null) return false;
      const content = (message as { content?: unknown }).content;
      return (
        Array.isArray(content) &&
        content.some(
          (block) =>
            typeof block === "object" &&
            block !== null &&
            (block as Record<string, unknown>).type === "tool_result" &&
            (block as Record<string, unknown>).tool_use_id === toolUseId &&
            ((block as Record<string, unknown>).is_error === true) ===
              expectedError,
        )
      );
    });
  } catch {
    return false;
  }
}

function writeSseEvent(
  response: ServerResponse,
  event: string,
  data: Record<string, unknown>,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function writeToolUseResponse(
  response: ServerResponse,
  turn: number,
  toolUse: {
    readonly id: string;
    readonly name: string;
    readonly input: Record<string, unknown>;
  },
): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": "text/event-stream",
    "request-id": `req_loopback_${turn}`,
  });
  writeSseEvent(response, "message_start", {
    type: "message_start",
    message: {
      id: `msg_loopback_${turn}`,
      type: "message",
      role: "assistant",
      model: MODEL_ALIAS,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  writeSseEvent(response, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "tool_use",
      id: toolUse.id,
      name: toolUse.name,
      input: {},
    },
  });
  writeSseEvent(response, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: {
      type: "input_json_delta",
      partial_json: JSON.stringify(toolUse.input),
    },
  });
  writeSseEvent(response, "content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });
  writeSseEvent(response, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  writeSseEvent(response, "message_stop", { type: "message_stop" });
  response.end();
}

function writeFinalResponse(response: ServerResponse, turn: number): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": "text/event-stream",
    "request-id": `req_loopback_${turn}`,
  });
  writeSseEvent(response, "message_start", {
    type: "message_start",
    message: {
      id: `msg_loopback_${turn}`,
      type: "message",
      role: "assistant",
      model: MODEL_ALIAS,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  writeSseEvent(response, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  writeSseEvent(response, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "done" },
  });
  writeSseEvent(response, "content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });
  writeSseEvent(response, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  writeSseEvent(response, "message_stop", { type: "message_stop" });
  response.end();
}

function writeHangingStream(response: ServerResponse, turn: number): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": "text/event-stream",
    "request-id": `req_loopback_${turn}`,
  });
  // The first fake-model turn launches Bash. Claude Code may immediately
  // request another turn after its Bash implementation backgrounds a long
  // command. Keep that synthetic continuation open until cancellation instead
  // of manufacturing duplicate tool calls that a real model never requested.
  response.write(": awaiting managed-agent cancellation\n\n");
}

it("enforces real-SDK built-in and in-process MCP calls with exact loopback correlation", async () => {
  const fixture = await createManagedAgentFixture(() => "loopback-nonce");
  const startedAt = Date.now();
  const stateSamples: Array<{
    readonly elapsedMs: number;
    readonly processes?: ManagedAgentKernelProcessTable;
  }> = [];
  const groupSignals: Array<{
    readonly elapsedMs: number;
    readonly groupId: number;
    readonly signal: "SIGKILL";
    readonly outcome: "sent" | "gone" | "failure";
  }> = [];
  const lifecycle: Array<{
    readonly elapsedMs: number;
    readonly event: string;
  }> = [];
  const observer = new LocalManagedAgentProcessObserver({
    readProcessTable: async () => {
      const observation = await readLoopbackProcessTable();
      stateSamples.push({
        elapsedMs: Date.now() - startedAt,
        ...(observation.available ? { processes: observation.processes } : {}),
      });
      return observation;
    },
    onTerminationRequest: ({ processGroupId: groupId }, outcome) => {
      groupSignals.push({
        elapsedMs: Date.now() - startedAt,
        groupId,
        signal: "SIGKILL",
        outcome,
      });
    },
  });
  let supervisorPid: number | undefined;
  const observedObserver: ManagedAgentProcessObserver = {
    spawn: (options) => {
      const child = observer.spawn(options);
      const pid = Reflect.get(child, "pid");
      supervisorPid = typeof pid === "number" ? pid : undefined;
      lifecycle.push({
        elapsedMs: Date.now() - startedAt,
        event: "observer_spawned",
      });
      return child;
    },
    beginTeardown: (deadline) => observer.beginTeardown(deadline),
    armToolProcessContainment: () => observer.armToolProcessContainment(),
    prepareCancellation: () => observer.prepareCancellation(),
    observeProcessTree: (timeoutMs) => observer.observeProcessTree(timeoutMs),
    waitForQuiescence: async (timeoutMs) => {
      lifecycle.push({
        elapsedMs: Date.now() - startedAt,
        event: "wait_for_quiescence_started",
      });
      const result = await observer.waitForQuiescence(timeoutMs);
      lifecycle.push({
        elapsedMs: Date.now() - startedAt,
        event: `wait_for_quiescence_settled:${result.quiescent}:${result.containmentSupported}`,
      });
      return result;
    },
    emergencyCleanup: async (timeoutMs) => {
      lifecycle.push({
        elapsedMs: Date.now() - startedAt,
        event: "host_emergency_cleanup_started",
      });
      const result = await observer.emergencyCleanup(timeoutMs);
      lifecycle.push({
        elapsedMs: Date.now() - startedAt,
        event: `host_emergency_cleanup_settled:${result.quiescent}:${result.containmentSupported}`,
      });
      return result;
    },
    dispose: () => observer.dispose(),
  };
  const observations: LoopbackObservation[] = [];
  let helloCount = 0;
  let inferenceTurn = 0;
  const server = createServer((request, response) => {
    if (request.method === "HEAD" && request.url === "/api/hello") {
      helloCount += 1;
      response.writeHead(200).end();
      return;
    }
    if (
      request.method !== "POST" ||
      request.url?.split("?")[0] !== "/v1/messages"
    ) {
      response.writeHead(404).end();
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 2_000_000) request.destroy();
    });
    request.on("end", () => {
      inferenceTurn += 1;
      const headerNames = Object.keys(request.headers).sort();
      observations.push({
        headerNames,
        evalSourceMatches:
          request.headers["x-sapiom-eval-source"] === EVAL_SOURCE,
        executionIdMatches:
          request.headers["x-sapiom-execution-id"] === EXECUTION_ID,
        promptMarkerPresent: body.includes(CORRELATION_MARKER),
        mcpResultMatches: hasSuccessfulMcpResult(body, fixture.nonce),
      });
      if (inferenceTurn === 1) {
        writeToolUseResponse(response, inferenceTurn, {
          id: "toolu_loopback_read",
          name: "Read",
          input: { file_path: FIXTURE_PATHS.cleanTarget },
        });
      } else if (inferenceTurn === 2) {
        writeToolUseResponse(response, inferenceTurn, {
          id: "toolu_loopback_bash_allow",
          name: "Bash",
          input: {
            command: ALLOWED_BASH_COMMAND,
            description: "Show working tree status",
          },
        });
      } else if (inferenceTurn === 3) {
        writeToolUseResponse(response, inferenceTurn, {
          id: "toolu_loopback_bash_deny",
          name: "Bash",
          input: { command: DENIED_BASH_COMMAND },
        });
      } else if (inferenceTurn === 4) {
        writeToolUseResponse(response, inferenceTurn, {
          id: "toolu_loopback_mcp_echo",
          name: ECHO_NONCE_TOOL,
          input: { nonce: fixture.nonce },
        });
      } else {
        writeFinalResponse(response, inferenceTurn);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    const ids = [RUN_ID, EXECUTION_ID];
    const result = await runManagedAgentProbe(
      {
        scenario: "L1",
        workspaceRoot: fixture.workspaceRoot,
        configRoot: fixture.configRoot,
        target: "sonnet-5",
        gatewayOrigin: `http://127.0.0.1:${address.port}`,
        gatewayCredential: "sk-ant-api03-local-loopback-only",
        prompt: fixture.prompt("L1"),
        maxTurns: 6,
        maxBudgetUsd: 0.25,
        allowedBashCommands: [ALLOWED_BASH_COMMAND],
        pathRoleBindings: fixture.pathRoleBindings,
        expectedL1FinalBytes: fixture.expectedL1FinalBytes,
        expectedMcpNonce: fixture.nonce,
        preservePaths: [
          FIXTURE_PATHS.dirtySentinel,
          FIXTURE_PATHS.untrackedSentinel,
        ],
      },
      {
        hermeticGatewayOrigin: `http://127.0.0.1:${address.port}`,
        processObserver: observedObserver,
        queryFactory: ({ prompt, options }) => {
          const sdkQuery = agentSdkQuery({ prompt, options });
          return {
            [Symbol.asyncIterator]: () => sdkQuery[Symbol.asyncIterator](),
            close: () => {
              lifecycle.push({
                elapsedMs: Date.now() - startedAt,
                event: "sdk_close_called",
              });
              sdkQuery.close();
            },
            return: async () => {
              lifecycle.push({
                elapsedMs: Date.now() - startedAt,
                event: "sdk_return_started",
              });
              const returned = await sdkQuery.return(undefined);
              lifecycle.push({
                elapsedMs: Date.now() - startedAt,
                event: "sdk_return_settled",
              });
              return returned;
            },
          };
        },
        uuid: () => {
          const id = ids.shift();
          if (!id) throw new Error("unexpected UUID request");
          return id;
        },
      },
    );

    expect(helloCount).toBeGreaterThanOrEqual(1);
    expect(observations).toHaveLength(5);
    expect(
      observations.every(
        ({ headerNames, evalSourceMatches, executionIdMatches }) =>
          headerNames.includes("x-sapiom-eval-source") &&
          headerNames.includes("x-sapiom-execution-id") &&
          evalSourceMatches &&
          executionIdMatches,
      ),
    ).toBe(true);
    expect(
      observations.every(({ promptMarkerPresent }) => promptMarkerPresent),
    ).toBe(true);
    expect(
      observations.map(({ mcpResultMatches }) => mcpResultMatches),
    ).toEqual([false, false, false, false, true]);
    const stateTransitions = stateSamples.reduce<
      Array<{
        readonly elapsedMs: number;
        readonly records: unknown;
      }>
    >((transitions, { elapsedMs, processes }) => {
      const records = processes
        ? [...processes.entries()]
            .filter(
              ([pid]) =>
                pid === supervisorPid ||
                result.teardown.observedPids.includes(pid),
            )
            .map(([pid, record]) => ({ pid, ...record }))
        : "unavailable";
      const previous = transitions.at(-1)?.records;
      if (JSON.stringify(previous) !== JSON.stringify(records)) {
        transitions.push({ elapsedMs, records });
      }
      return transitions;
    }, []);
    expect(
      result.terminal,
      JSON.stringify({
        groupSignals,
        lifecycle,
        processTableSampleCount: stateSamples.length,
        stateTransitions,
        teardown: result.teardown,
        terminationEvidence: result.terminationEvidence,
      }),
    ).toBe("success");
    expect(result.sdkModelEvidence).toEqual({
      authority: "sdk_non_authoritative",
      initModelObserved: true,
      initModelMatchesExpectedAlias: true,
      resultModelUsageObserved: true,
      resultModelUsageMatchesExpectedAlias: true,
      resultModelCount: 1,
    });

    const requested = result.toolEvidence.filter(
      ({ status }) => status === "requested",
    );
    expect(requested.map(({ toolName }) => toolName)).toEqual([
      "Read",
      "Bash",
      "Bash",
      ECHO_NONCE_TOOL,
    ]);
    for (const tool of requested) {
      expect(
        result.permissionEvidence.filter(
          ({ toolUseId, source }) =>
            toolUseId === tool.toolUseId && source === "pre_tool_use",
        ),
      ).toHaveLength(1);
    }
    expect(result.permissionEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "Read",
          decision: "allow",
          reason: "fixture_path",
          source: "pre_tool_use",
        }),
        expect.objectContaining({
          toolName: "Bash",
          decision: "allow",
          reason: "exact_bash_command",
          source: "pre_tool_use",
        }),
        expect.objectContaining({
          toolName: "Bash",
          decision: "deny",
          reason: "bash_command_not_allowed",
          source: "pre_tool_use",
        }),
        expect.objectContaining({
          toolName: ECHO_NONCE_TOOL,
          decision: "allow",
          reason: "managed_mcp_tool",
          source: "pre_tool_use",
        }),
      ]),
    );
    expect(result.toolEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: "Read", status: "success" }),
        expect.objectContaining({ toolName: "Bash", status: "success" }),
        expect.objectContaining({ toolName: "Bash", status: "error" }),
      ]),
    );
    const requestedMcp = requested.find(
      ({ toolName }) => toolName === ECHO_NONCE_TOOL,
    );
    expect(requestedMcp?.toolUseId).toBeDefined();
    expect(
      result.toolEvidence.filter(
        ({ toolName, toolUseId, status }) =>
          toolName === ECHO_NONCE_TOOL &&
          toolUseId === requestedMcp?.toolUseId &&
          status === "success",
      ),
    ).toHaveLength(1);
    expect(
      result.toolEvidence.filter(
        ({ toolName, toolUseId }) =>
          toolName === ECHO_NONCE_TOOL && toolUseId === undefined,
      ),
    ).toEqual([]);
    expect(result.policyHookCoverage).toBe(true);
    expect(
      await fixturePathExists(
        join(fixture.workspaceRoot, "denied-side-effect.txt"),
      ),
    ).toBe(false);
    expect(result.queryClosed).toBe(true);
    expect(result.teardown.quiescent).toBe(true);
  } finally {
    await observer.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.cleanup();
  }
}, 45_000);

it.skipIf(
  process.platform === "win32" ||
    process.versions.node !== MANAGED_AGENT_CONTRACT.certificationNodeVersion,
)(
  "cancels the real SDK L2 Bash fixture without leaving its detached process group",
  async () => {
    const fixture = await createManagedAgentFixture(
      () => "loopback-l2-cancellation",
    );
    const startedAt = Date.now();
    const stateSamples: Array<{
      readonly elapsedMs: number;
      readonly processes?: ManagedAgentKernelProcessTable;
    }> = [];
    const groupSignals: Array<{
      readonly elapsedMs: number;
      readonly groupId: number;
      readonly signal: "SIGKILL";
      readonly outcome: "sent" | "gone" | "failure";
    }> = [];
    const observer = new LocalManagedAgentProcessObserver({
      readProcessTable: async () => {
        const observation = await readLoopbackProcessTable();
        stateSamples.push({
          elapsedMs: Date.now() - startedAt,
          ...(observation.available
            ? { processes: observation.processes }
            : {}),
        });
        return observation;
      },
      onTerminationRequest: ({ processGroupId: groupId }, outcome) => {
        groupSignals.push({
          elapsedMs: Date.now() - startedAt,
          groupId,
          signal: "SIGKILL",
          outcome,
        });
      },
    });
    const cleanupOrder: string[] = [];
    let supervisorPid: number | undefined;
    const observedObserver: ManagedAgentProcessObserver = {
      spawn: (options) => {
        options.signal.addEventListener(
          "abort",
          () => cleanupOrder.push("sdk_forwarded_signal"),
          { once: true },
        );
        const child = observer.spawn(options);
        const nativeKill = child.kill.bind(child);
        Reflect.set(child, "kill", (signal: NodeJS.Signals = "SIGTERM") => {
          cleanupOrder.push("sdk_native_kill");
          return nativeKill(signal);
        });
        const pid = Reflect.get(child, "pid");
        supervisorPid = typeof pid === "number" ? pid : undefined;
        return child;
      },
      beginTeardown: (deadline) => observer.beginTeardown(deadline),
      armToolProcessContainment: () => observer.armToolProcessContainment(),
      prepareCancellation: () => observer.prepareCancellation(),
      observeProcessTree: (timeoutMs) => observer.observeProcessTree(timeoutMs),
      waitForQuiescence: (timeoutMs) => observer.waitForQuiescence(timeoutMs),
      emergencyCleanup: (timeoutMs) => {
        cleanupOrder.push("host_emergency_cleanup");
        return observer.emergencyCleanup(timeoutMs);
      },
      dispose: () => observer.dispose(),
    };
    const unrelated = spawnCooperativeUnrelatedProcess();
    await once(unrelated, "spawn");
    let fixturePids: readonly number[] = [];
    let fixtureToolProcessGroupId: number | undefined;
    let cancellationStartedAt: number | undefined;
    let inferenceTurn = 0;
    const server = createServer((request, response) => {
      if (request.method === "HEAD" && request.url === "/api/hello") {
        response.writeHead(200).end();
        return;
      }
      if (
        request.method !== "POST" ||
        request.url?.split("?")[0] !== "/v1/messages"
      ) {
        response.writeHead(404).end();
        return;
      }
      request.resume();
      request.once("end", () => {
        inferenceTurn += 1;
        if (inferenceTurn === 1) {
          writeToolUseResponse(response, inferenceTurn, {
            id: "toolu_loopback_l2_bash",
            name: "Bash",
            input: { command: fixture.l2BashCommand },
          });
        } else {
          writeHangingStream(response, inferenceTurn);
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address() as AddressInfo;
      const ids = [RUN_ID, EXECUTION_ID];
      const result = await runManagedAgentProbe(
        {
          scenario: "L2",
          workspaceRoot: fixture.workspaceRoot,
          configRoot: fixture.configRoot,
          target: "sonnet-5",
          gatewayOrigin: `http://127.0.0.1:${address.port}`,
          gatewayCredential: "sk-ant-api03-local-loopback-only",
          prompt: fixture.prompt("L2"),
          maxTurns: 4,
          maxBudgetUsd: 0.25,
          allowedBashCommands: [fixture.l2BashCommand],
          pathRoleBindings: [],
          expectedL1FinalBytes: [],
          preservePaths: [
            FIXTURE_PATHS.dirtySentinel,
            FIXTURE_PATHS.untrackedSentinel,
          ],
        },
        {
          hermeticGatewayOrigin: `http://127.0.0.1:${address.port}`,
          processObserver: observedObserver,
          queryFactory: ({ prompt, options }) => {
            const sdkQuery = agentSdkQuery({ prompt, options });
            return {
              [Symbol.asyncIterator]: () => sdkQuery[Symbol.asyncIterator](),
              close: () => {
                cleanupOrder.push("sdk_close_called");
                sdkQuery.close();
              },
              return: async () => {
                cleanupOrder.push("sdk_return_started");
                const returned = await sdkQuery.return(undefined);
                cleanupOrder.push("sdk_return_settled");
                return returned;
              },
            };
          },
          waitForCancellationSignal: async (signal) => {
            fixturePids = await waitForManagedAgentFixturePids(
              fixture,
              10_000,
              signal,
            );
            const readiness = await observer.prepareCancellation();
            expect(readiness).toMatchObject({
              supported: true,
              reason: "ready",
              containmentSupported: true,
              ownershipProven: true,
            });
            expect(
              fixturePids.every((pid) => readiness.observedPids.includes(pid)),
            ).toBe(true);
            let readinessProcessTable:
              | ManagedAgentKernelProcessTable
              | undefined;
            for (let index = stateSamples.length - 1; index >= 0; index -= 1) {
              const processes = stateSamples[index]?.processes;
              if (!processes?.has(fixturePids[0]!)) continue;
              readinessProcessTable = processes;
              break;
            }
            fixtureToolProcessGroupId = readinessProcessTable?.get(
              fixturePids[0]!,
            )?.processGroupId;
            expect(fixtureToolProcessGroupId).toBeTypeOf("number");
            expect(
              fixturePids.every(
                (pid) =>
                  readinessProcessTable?.get(pid)?.processGroupId ===
                  fixtureToolProcessGroupId,
              ),
            ).toBe(true);
            cancellationStartedAt = Date.now();
          },
          uuid: () => {
            const id = ids.shift();
            if (!id) throw new Error("unexpected UUID request");
            return id;
          },
        },
      );
      const cancellationElapsedMs =
        Date.now() - (cancellationStartedAt ?? startedAt);
      const stateTransitions = stateSamples.reduce<
        Array<{
          readonly elapsedMs: number;
          readonly records: unknown;
        }>
      >((transitions, { elapsedMs, processes }) => {
        const records = processes
          ? [...processes.entries()]
              .filter(
                ([pid]) =>
                  pid === supervisorPid ||
                  fixturePids.includes(pid) ||
                  result.teardown.observedPids.includes(pid),
              )
              .map(([pid, record]) => ({ pid, ...record }))
          : "unavailable";
        const previous = transitions.at(-1)?.records;
        if (JSON.stringify(previous) !== JSON.stringify(records)) {
          transitions.push({ elapsedMs, records });
        }
        return transitions;
      }, []);

      expect(inferenceTurn).toBeGreaterThanOrEqual(1);
      expect(inferenceTurn).toBeLessThanOrEqual(2);
      expect(result.inferenceTurns).toBe(1);
      expect(
        result.terminal,
        JSON.stringify({
          cleanupOrder,
          elapsedMs: cancellationElapsedMs,
          groupSignals,
          queryClosed: result.queryClosed,
          stateTransitions,
          teardown: result.teardown,
          terminationEvidence: result.terminationEvidence,
        }),
      ).toBe("cancelled");
      expect(cancellationElapsedMs).toBeLessThan(5_000);
      expect(result.cancellationRequested).toBe(true);
      expect(result.queryClosed).toBe(true);
      expect(result.teardown).toMatchObject({
        quiescent: true,
        deadlineMet: true,
        processTableAvailable: true,
        containmentSupported: true,
        ownershipProven: true,
        forceKillIssued: true,
        toolProcessObservationComplete: true,
        toolProcessChannelsClosed: true,
        alivePidsAtDeadline: [],
      });
      expect(fixturePids).toHaveLength(2);
      expect(fixturePids.every((pid) => !processExists(pid))).toBe(true);
      expect(processExists(unrelated.pid!)).toBe(true);
      expect(
        groupSignals.map(({ groupId, signal }) => [groupId, signal]),
      ).toEqual([
        [fixtureToolProcessGroupId, "SIGKILL"],
        [supervisorPid, "SIGKILL"],
      ]);
      expect(cleanupOrder).toEqual(
        expect.arrayContaining([
          "sdk_close_called",
          "sdk_return_started",
          "sdk_return_settled",
          "host_emergency_cleanup",
        ]),
      );
      expect(cleanupOrder.indexOf("sdk_close_called")).toBeLessThan(
        cleanupOrder.indexOf("sdk_return_started"),
      );
      expect(cleanupOrder.indexOf("sdk_return_started")).toBeLessThan(
        cleanupOrder.indexOf("sdk_return_settled"),
      );
      expect(cleanupOrder.indexOf("sdk_return_settled")).toBeLessThan(
        cleanupOrder.indexOf("host_emergency_cleanup"),
      );
      const forwardedSignalIndex = cleanupOrder.indexOf("sdk_forwarded_signal");
      const nativeKillIndexes = cleanupOrder.flatMap((step, index) =>
        step === "sdk_native_kill" ? [index] : [],
      );
      expect(cleanupOrder).toEqual([
        "sdk_close_called",
        "sdk_return_started",
        "sdk_native_kill",
        "sdk_forwarded_signal",
        "sdk_native_kill",
        "sdk_return_settled",
        "host_emergency_cleanup",
      ]);
      expect(nativeKillIndexes).toEqual([2, 4]);
      expect(forwardedSignalIndex).toBeGreaterThanOrEqual(0);
      expect(nativeKillIndexes[0]).toBeLessThan(forwardedSignalIndex);
      expect(nativeKillIndexes[1]).toBeGreaterThan(forwardedSignalIndex);
      expect(forwardedSignalIndex).toBeLessThan(
        cleanupOrder.indexOf("host_emergency_cleanup"),
      );
    } finally {
      await observer.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(fixturePids.map((pid) => waitForProcessDeath(pid)));
      await stopCooperativeUnrelatedProcess(unrelated);
      await fixture.cleanup();
    }
    expect(fixturePids.every((pid) => !processExists(pid))).toBe(true);
  },
  20_000,
);

it.skipIf(
  process.platform === "win32" ||
    process.versions.node !== MANAGED_AGENT_CONTRACT.certificationNodeVersion,
)(
  "fails closed through the runtime timeout fallback when the SDK signal is not forwarded",
  async () => {
    const fixture = await createManagedAgentFixture(
      () => "loopback-l2-missing-forwarded-signal",
    );
    const observer = new LocalManagedAgentProcessObserver();
    const neverForwardedController = new AbortController();
    const cleanupOrder: string[] = [];
    const observedObserver: ManagedAgentProcessObserver = {
      spawn: (options) => {
        options.signal.addEventListener(
          "abort",
          () => cleanupOrder.push("sdk_forwarded_signal_unobserved"),
          { once: true },
        );
        return observer.spawn({
          ...options,
          signal: neverForwardedController.signal,
        });
      },
      beginTeardown: (deadline) => observer.beginTeardown(deadline),
      armToolProcessContainment: () => observer.armToolProcessContainment(),
      prepareCancellation: () => observer.prepareCancellation(),
      observeProcessTree: (timeoutMs) => observer.observeProcessTree(timeoutMs),
      waitForQuiescence: (timeoutMs) => observer.waitForQuiescence(timeoutMs),
      emergencyCleanup: (timeoutMs) => {
        cleanupOrder.push("host_timeout_fallback");
        return observer.emergencyCleanup(timeoutMs);
      },
      dispose: () => observer.dispose(),
    };
    const unrelated = spawnCooperativeUnrelatedProcess();
    await once(unrelated, "spawn");
    let fixturePids: readonly number[] = [];
    let cancellationStartedAt: number | undefined;
    let inferenceTurn = 0;
    const server = createServer((request, response) => {
      if (request.method === "HEAD" && request.url === "/api/hello") {
        response.writeHead(200).end();
        return;
      }
      if (
        request.method !== "POST" ||
        request.url?.split("?")[0] !== "/v1/messages"
      ) {
        response.writeHead(404).end();
        return;
      }
      request.resume();
      request.once("end", () => {
        inferenceTurn += 1;
        if (inferenceTurn === 1) {
          writeToolUseResponse(response, inferenceTurn, {
            id: "toolu_loopback_l2_missing_forwarded_signal",
            name: "Bash",
            input: { command: fixture.l2BashCommand },
          });
        } else {
          writeHangingStream(response, inferenceTurn);
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address() as AddressInfo;
      const ids = [RUN_ID, EXECUTION_ID];
      const result = await runManagedAgentProbe(
        {
          scenario: "L2",
          workspaceRoot: fixture.workspaceRoot,
          configRoot: fixture.configRoot,
          target: "sonnet-5",
          gatewayOrigin: `http://127.0.0.1:${address.port}`,
          gatewayCredential: "sk-ant-api03-local-loopback-only",
          prompt: fixture.prompt("L2"),
          maxTurns: 4,
          maxBudgetUsd: 0.25,
          allowedBashCommands: [fixture.l2BashCommand],
          pathRoleBindings: [],
          expectedL1FinalBytes: [],
          preservePaths: [
            FIXTURE_PATHS.dirtySentinel,
            FIXTURE_PATHS.untrackedSentinel,
          ],
        },
        {
          hermeticGatewayOrigin: `http://127.0.0.1:${address.port}`,
          processObserver: observedObserver,
          queryFactory: ({ prompt, options }) => {
            const sdkQuery = agentSdkQuery({ prompt, options });
            return {
              [Symbol.asyncIterator]: () => sdkQuery[Symbol.asyncIterator](),
              close: () => {
                cleanupOrder.push("sdk_close_called");
                sdkQuery.close();
              },
              return: async () => {
                cleanupOrder.push("sdk_return_started");
                await sdkQuery.return(undefined);
                cleanupOrder.push("sdk_return_underlying_settled");
                return new Promise<IteratorResult<unknown>>(() => undefined);
              },
            };
          },
          waitForCancellationSignal: async (signal) => {
            fixturePids = await waitForManagedAgentFixturePids(
              fixture,
              10_000,
              signal,
            );
            await expect(observer.prepareCancellation()).resolves.toMatchObject(
              {
                supported: true,
                reason: "ready",
                containmentSupported: true,
                ownershipProven: true,
              },
            );
            cancellationStartedAt = Date.now();
          },
          uuid: () => {
            const id = ids.shift();
            if (!id) throw new Error("unexpected UUID request");
            return id;
          },
        },
      );
      const cancellationElapsedMs =
        Date.now() - (cancellationStartedAt ?? Date.now());

      expect(inferenceTurn).toBeGreaterThanOrEqual(1);
      expect(inferenceTurn).toBeLessThanOrEqual(2);
      expect(result.inferenceTurns).toBe(1);
      expect(result.terminal).toBe("close_timeout");
      expect(result.cancellationRequested).toBe(true);
      expect(result.queryClosed).toBe(false);
      expect(result.teardown).toMatchObject({
        quiescent: true,
        deadlineMet: true,
        processTableAvailable: true,
        containmentSupported: true,
        ownershipProven: true,
        forceKillIssued: true,
        toolProcessObservationComplete: true,
        toolProcessChannelsClosed: true,
        alivePidsAtDeadline: [],
      });
      expect(result.teardown.elapsedMs).toBeLessThanOrEqual(5_000);
      expect(cancellationElapsedMs).toBeLessThanOrEqual(5_000);
      expect(fixturePids).toHaveLength(2);
      expect(fixturePids.every((pid) => !processExists(pid))).toBe(true);
      expect(processExists(unrelated.pid!)).toBe(true);
      expect(cleanupOrder).toEqual(
        expect.arrayContaining([
          "sdk_close_called",
          "sdk_return_started",
          "sdk_return_underlying_settled",
          "sdk_forwarded_signal_unobserved",
          "host_timeout_fallback",
        ]),
      );
      expect(
        cleanupOrder.indexOf("sdk_forwarded_signal_unobserved"),
      ).toBeLessThan(cleanupOrder.indexOf("host_timeout_fallback"));
    } finally {
      await observer.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(fixturePids.map((pid) => waitForProcessDeath(pid)));
      await stopCooperativeUnrelatedProcess(unrelated);
      await fixture.cleanup();
    }
    expect(fixturePids.every((pid) => !processExists(pid))).toBe(true);
  },
  20_000,
);

it.skipIf(
  process.platform === "win32" ||
    process.versions.node !== MANAGED_AGENT_CONTRACT.certificationNodeVersion,
)(
  "keeps readiness-failure evidence fail-closed after cooperative disposal",
  async () => {
    const fixture = await createManagedAgentFixture(
      () => "loopback-l2-early-error",
    );
    const observer = new LocalManagedAgentProcessObserver();
    let fixturePids: readonly number[] = [];
    let inferenceTurn = 0;
    const server = createServer((request, response) => {
      if (request.method === "HEAD" && request.url === "/api/hello") {
        response.writeHead(200).end();
        return;
      }
      if (
        request.method !== "POST" ||
        request.url?.split("?")[0] !== "/v1/messages"
      ) {
        response.writeHead(404).end();
        return;
      }
      request.resume();
      request.once("end", () => {
        inferenceTurn += 1;
        writeToolUseResponse(response, inferenceTurn, {
          id: "toolu_loopback_l2_early_error",
          name: "Bash",
          input: { command: fixture.l2BashCommand },
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    let recordedTerminal: string | undefined;
    try {
      const address = server.address() as AddressInfo;
      const ids = [RUN_ID, EXECUTION_ID];
      const result = await runManagedAgentProbe(
        {
          scenario: "L2",
          workspaceRoot: fixture.workspaceRoot,
          configRoot: fixture.configRoot,
          target: "sonnet-5",
          gatewayOrigin: `http://127.0.0.1:${address.port}`,
          gatewayCredential: "sk-ant-api03-local-loopback-only",
          prompt: fixture.prompt("L2"),
          maxTurns: 4,
          maxBudgetUsd: 0.25,
          allowedBashCommands: [fixture.l2BashCommand],
          pathRoleBindings: [],
          expectedL1FinalBytes: [],
          preservePaths: [
            FIXTURE_PATHS.dirtySentinel,
            FIXTURE_PATHS.untrackedSentinel,
          ],
        },
        {
          hermeticGatewayOrigin: `http://127.0.0.1:${address.port}`,
          processObserver: observer,
          queryFactory: ({ prompt, options }) =>
            agentSdkQuery({ prompt, options }),
          waitForCancellationSignal: async (signal) => {
            fixturePids = await waitForManagedAgentFixturePids(
              fixture,
              10_000,
              signal,
            );
            throw new Error("synthetic readiness failure");
          },
          uuid: () => {
            const id = ids.shift();
            if (!id) throw new Error("unexpected UUID request");
            return id;
          },
        },
      );

      expect(inferenceTurn).toBe(1);
      recordedTerminal = result.terminal;
      expect(result.terminal).toBe("teardown_timeout");
      expect(result.cancellationRequested).toBe(false);
      expect(result.terminationEvidence).toEqual({
        beforePolicyOverride: "teardown_timeout",
        queryExecution: "iteration_aborted",
        sdkResult: "not_observed",
      });
      expect(result.queryClosed).toBe(true);
      expect(result.teardown).toMatchObject({
        quiescent: false,
        deadlineMet: false,
        containmentSupported: false,
        ownershipProven: false,
        forceKillIssued: false,
        toolProcessObservationComplete: false,
        toolProcessChannelsClosed: false,
      });
      expect(fixturePids).toHaveLength(2);
      expect(
        fixturePids.every((pid) =>
          result.teardown.alivePidsAtDeadline.includes(pid),
        ),
      ).toBe(true);
      await Promise.all(fixturePids.map((pid) => waitForProcessDeath(pid)));
      expect(fixturePids.every((pid) => !processExists(pid))).toBe(true);
      expect(result.terminal).toBe("teardown_timeout");
      expect(
        fixturePids.every((pid) =>
          result.teardown.alivePidsAtDeadline.includes(pid),
        ),
      ).toBe(true);
    } finally {
      await observer.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(fixturePids.map((pid) => waitForProcessDeath(pid)));
      await fixture.cleanup();
    }
    expect(recordedTerminal).toBe("teardown_timeout");
    expect(fixturePids.every((pid) => !processExists(pid))).toBe(true);
  },
  20_000,
);

it.skipIf(
  process.versions.node !== MANAGED_AGENT_CONTRACT.certificationNodeVersion,
)(
  "keeps malformed real-SDK Edit requests outside strict primary-hook coverage",
  async () => {
    const fixture = await createManagedAgentFixture(
      () => "loopback-malformed-edit",
    );
    const malformedToolUseId = "toolu_loopback_malformed_edit";
    const validToolUseId = "toolu_loopback_valid_edit";
    const observedMalformedError: boolean[] = [];
    const observedValidSuccess: boolean[] = [];
    let inferenceTurn = 0;
    const server = createServer((request, response) => {
      if (request.method === "HEAD" && request.url === "/api/hello") {
        response.writeHead(200).end();
        return;
      }
      if (
        request.method !== "POST" ||
        request.url?.split("?")[0] !== "/v1/messages"
      ) {
        response.writeHead(404).end();
        return;
      }

      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 2_000_000) request.destroy();
      });
      request.on("end", () => {
        inferenceTurn += 1;
        observedMalformedError.push(
          hasToolResult(body, malformedToolUseId, true),
        );
        observedValidSuccess.push(hasToolResult(body, validToolUseId, false));
        if (inferenceTurn === 1) {
          writeToolUseResponse(response, inferenceTurn, {
            id: malformedToolUseId,
            name: "Edit",
            input: {
              file_path: FIXTURE_PATHS.cleanTarget,
              new_string: fixture.cleanTargetReplacement,
            },
          });
        } else if (inferenceTurn === 2) {
          writeToolUseResponse(response, inferenceTurn, {
            id: validToolUseId,
            name: "Edit",
            input: {
              file_path: FIXTURE_PATHS.cleanTarget,
              old_string: "clean target base\n",
              new_string: fixture.cleanTargetReplacement,
              replace_all: false,
            },
          });
        } else {
          writeFinalResponse(response, inferenceTurn);
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const sdkPackage = JSON.parse(
        await readFile(
          join(
            dirname(require.resolve("@anthropic-ai/claude-agent-sdk")),
            "package.json",
          ),
          "utf8",
        ),
      ) as { version?: unknown };
      expect(sdkPackage.version).toBe(MANAGED_AGENT_CONTRACT.agentSdkVersion);
      expect(process.versions.node).toBe(
        MANAGED_AGENT_CONTRACT.certificationNodeVersion,
      );

      const address = server.address() as AddressInfo;
      const ids = [RUN_ID, EXECUTION_ID];
      const result = await runManagedAgentProbe(
        {
          scenario: "L1",
          workspaceRoot: fixture.workspaceRoot,
          configRoot: fixture.configRoot,
          target: "sonnet-5",
          gatewayOrigin: `http://127.0.0.1:${address.port}`,
          gatewayCredential: "sk-ant-api03-local-loopback-only",
          prompt: fixture.prompt("L1"),
          maxTurns: 4,
          maxBudgetUsd: 0.25,
          allowedBashCommands: [],
          pathRoleBindings: fixture.pathRoleBindings,
          expectedL1FinalBytes: fixture.expectedL1FinalBytes,
          expectedMcpNonce: fixture.nonce,
          preservePaths: [
            FIXTURE_PATHS.dirtySentinel,
            FIXTURE_PATHS.untrackedSentinel,
          ],
        },
        {
          hermeticGatewayOrigin: `http://127.0.0.1:${address.port}`,
          queryFactory: ({ prompt, options }) =>
            agentSdkQuery({ prompt, options }),
          uuid: () => {
            const id = ids.shift();
            if (!id) throw new Error("unexpected UUID request");
            return id;
          },
        },
      );

      expect(inferenceTurn).toBe(3);
      expect(observedMalformedError).toEqual([false, true, true]);
      expect(observedValidSuccess).toEqual([false, false, true]);
      const requestedEdits = result.toolEvidence.filter(
        ({ toolName, status }) => toolName === "Edit" && status === "requested",
      );
      expect(requestedEdits).toHaveLength(2);
      const [malformedEdit, validEdit] = requestedEdits;
      expect(
        result.permissionEvidence.filter(
          ({ toolUseId, source }) =>
            toolUseId === malformedEdit?.toolUseId && source === "pre_tool_use",
        ),
      ).toHaveLength(0);
      expect(
        result.toolEvidence.filter(
          ({ toolUseId, status }) =>
            toolUseId === malformedEdit?.toolUseId && status === "error",
        ),
      ).toHaveLength(1);
      expect(
        result.permissionEvidence.filter(
          ({ toolUseId, source, decision }) =>
            toolUseId === validEdit?.toolUseId &&
            source === "pre_tool_use" &&
            decision === "allow",
        ),
      ).toHaveLength(1);
      expect(
        result.toolEvidence.filter(
          ({ toolUseId, status }) =>
            toolUseId === validEdit?.toolUseId && status === "success",
        ),
      ).toHaveLength(1);
      expect(result.policyDiagnostics).toEqual([
        {
          kind: "missing_pre_tool_use_callback",
          reason: "no_callback_observed",
          toolName: "Edit",
          correlatedRequest: true,
        },
      ]);
      expect(result.policyHookCoverage).toBe(false);
      expect(result.terminal).toBe("policy_violation");
      expect(result.terminationEvidence).toEqual({
        beforePolicyOverride: "success",
        queryExecution: "iteration_completed",
        sdkResult: "success",
      });
      expect(
        await readFile(
          join(fixture.workspaceRoot, FIXTURE_PATHS.cleanTarget),
          "utf8",
        ),
      ).toBe(fixture.cleanTargetReplacement);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fixture.cleanup();
    }
  },
  45_000,
);
