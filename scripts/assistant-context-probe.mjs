// Run through the SDK's tsx: see packages/opencode/docs/context-probe.md.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectStudioSystem } from "./assistant-context-projection.mjs";

const sdk = resolve(process.argv[2] ?? ".");
const output = resolve(process.argv[3] ?? "context-probe.json");
const source = (path) => import(pathToFileURL(join(sdk, path)).href);
const { startOpenCodeServer } = await source("packages/opencode/src/server.ts");
const { createSapiomOpenCodeConfig } = await source(
  "packages/opencode/src/config.ts",
);
const {
  openCodeCompletionPrompt,
  openCodeCompletionTokens,
  parseOpenCodeCompletion,
} = await source("packages/harness/src/shared/opencode-completion.ts");
const contextPath = "packages/harness/src/core/studio-assistant-context.ts";
const hasDraft = await access(join(sdk, contextPath)).then(
  () => true,
  (error) => {
    if (error.code !== "ENOENT") throw error;
    return false;
  },
);
const draft = hasDraft ? await source(contextPath) : null;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const root = await mkdtemp(join(tmpdir(), "studio-context-assessment-"));
const cwd = join(root, "project");
const trusted = join(root, "trusted.md");
const skillFile = join(root, "skills", "context-fixture", "SKILL.md");
const rootRule = "ROOT_RULE_CANARY";
const nestedRule = "NESTED_RULE_V1";
const requests = [];
const checks = {};
let phase = "initial",
  completed = false,
  actions = [],
  runtime,
  projected = false;
const nativeSystem = (body) =>
  (body.input ?? [])
    .filter((item) => ["system", "developer"].includes(item.role))
    .flatMap((item) =>
      typeof item.content === "string"
        ? [item.content]
        : item.content.map((part) => part.text ?? ""),
    )
    .join("\n");
const mark = (name, condition) => {
  checks[name] = !!condition;
  assert.ok(condition, name);
};
const skill = (version) =>
  `---\nname: context-fixture\ndescription: Controlled context fixture.\n---\nSKILL_BODY_${version}\n`;
const context = (selected = "Cedar", version = "V1") => ({
  schemaVersion: 1,
  revision: version,
  session: { id: "studio-fixture", cwd, projectId: "fixture" },
  environment: "fixture",
  selectedAgent: {
    status: "available",
    agent: { name: selected, path: join(cwd, selected), definitionId: null },
  },
  boundAgent: {
    status: "available",
    agent: { name: "Cedar", path: join(cwd, "Cedar"), definitionId: null },
  },
  agents: [],
  capabilities: [{ name: "fixture", status: "available", tools: ["ping"] }],
  guidance: [
    {
      id: "studio-profile",
      kind: "profile",
      required: true,
      source: "fixture",
      status: "available",
      revision: version,
      text: `PROFILE_${version}\n` + "Stable Studio guidance. ".repeat(300),
    },
  ],
});
const compose = (value) =>
  draft?.composeAssistantPrompt(value) ?? {
    system:
      openCodeCompletionPrompt().system +
      "\n\nStudioAssistantContext/v1\nFixture policy\n" +
      JSON.stringify(value),
  };
const recover = (system) =>
  draft?.recoverAssistantPrompt(system) ?? {
    system:
      openCodeCompletionPrompt().system +
      system.slice(system.indexOf("\n\nStudioAssistantContext/v1\n")),
  };

const bridge = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url.endsWith("/mcp")) {
      if (req.method === "GET") return void res.writeHead(405).end();
      if (body.id === undefined) return void res.writeHead(202).end();
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: body.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
              instructions: "MCP_INSTRUCTION_CANARY",
            }
          : body.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "ping",
                    description: "MCP_TOOL_CANARY",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              }
            : { content: [{ type: "text", text: "MCP_RESULT_CANARY" }] };
      return void res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    }
    if (!req.url.endsWith("/responses")) return void res.writeHead(404).end();
    const work = !!body.tools?.length;
    requests.push({ phase, projected, work, body });
    const instruction = nativeSystem(body);
    const token = [
      ...instruction.matchAll(
        /(?:^|\n)StudioAssistantResult\/v2:([a-f0-9-]{36})\n/g,
      ),
    ].at(-1)?.[1];
    const action = work ? actions.shift() : undefined;
    if (phase === "initial" && action?.name === "read") {
      await writeFile(trusted, "EXPLICIT_GUIDE_V2");
      await writeFile(skillFile, skill("V2"));
    }
    const id = `resp_${requests.length}`;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (type, fields) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
      );
    const base = { id, object: "response", created_at: 1, model: "gpt-luna" };
    emit("response.created", {
      response: { ...base, status: "in_progress", output: [] },
    });
    const item = action
      ? {
          id: `fc_${id}`,
          type: "function_call",
          call_id: `call_${id}`,
          name: action.name,
          arguments: JSON.stringify(action.arguments),
          status: "completed",
        }
      : {
          id: `msg_${id}`,
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: work
                ? `<!-- studio-result:${token}:finished -->\nFIXTURE_HISTORY_CANARY ${phase}`
                : "Fixture summary: Cedar and Orchid; preserve the user's context and completed reads.",
              annotations: [],
            },
          ],
          status: "completed",
        };
    emit("response.output_item.added", {
      output_index: 0,
      item: {
        ...item,
        ...(action ? { arguments: "" } : { content: [] }),
        status: "in_progress",
      },
    });
    if (action)
      emit("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: item.id,
        delta: item.arguments,
      });
    else
      emit("response.output_text.delta", {
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        delta: item.content[0].text,
      });
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", {
      response: {
        ...base,
        status: "completed",
        output: [item],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      },
    });
    res.end();
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});

const request = (path, body) =>
  runtime.fetchJson(path, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(90_000),
  });
const send = async (id, prompt, text) =>
  request(`/session/${id}/message`, {
    ...prompt,
    model: { providerID: "sapiom", modelID: "gpt-luna" },
    parts: [{ type: "text", text }],
  });
const workIn = (name) =>
  requests.filter((item) => item.phase === name && item.work);
let config, history;
try {
  await mkdir(join(cwd, "nested"), { recursive: true });
  await mkdir(dirname(skillFile), { recursive: true });
  await Promise.all([
    writeFile(join(cwd, "AGENTS.md"), rootRule),
    writeFile(join(cwd, "CLAUDE.md"), "ROOT_CLAUDE_CANARY"),
    writeFile(join(cwd, "nested", "AGENTS.md"), nestedRule),
    writeFile(join(cwd, "nested", "index.ts"), "export const value = 42;"),
    writeFile(trusted, "EXPLICIT_GUIDE_V1"),
    writeFile(skillFile, skill("V1")),
  ]);
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${bridge.address().port}`;
  config = createSapiomOpenCodeConfig({
    bridgeUrl: origin,
    runtimeToken: "fixture-only",
    model: "gpt-luna",
  });
  config.provider.sapiom.npm = "@ai-sdk/openai";
  config.provider.sapiom.options.baseURL = `${origin}/llm/v1`;
  config.instructions = [trusted];
  config.skills = { paths: [join(root, "skills")] };
  const start = () =>
    startOpenCodeServer({
      cwd,
      stateRoot: join(root, "native"),
      config,
      startupTimeoutMs: 30_000,
      beforeLaunch: async () => {
        if (!projected) return;
        // Assessment seam: extend the generated host plugin, preserving isolation.
        // Arbitrary config.plugin entries are intentionally replaced by the host.
        for (const entry of await readdir(join(root, "native"))) {
          if (!entry.startsWith("launch-")) continue;
          const file = join(root, "native", entry, "credential-isolation.mjs");
          const original = await readFile(file, "utf8");
          assert.ok(original.includes("...completionHooks,"));
          await writeFile(
            file,
            original.replace(
              "...completionHooks,",
              `...completionHooks,\n'experimental.chat.system.transform': async (_input, output) => { output.system.splice(0, output.system.length, ...output.system.map(projectStudioSystem)); },`,
            ) + `\n${projectStudioSystem.toString()}\n`,
          );
        }
      },
    });
  runtime = await start();
  const session = await request("/session", { title: "Context assessment" });
  const first = compose(context());
  actions = [
    { name: "read", arguments: { filePath: join(cwd, "nested", "index.ts") } },
    { name: "skill", arguments: { name: "context-fixture" } },
    {
      name: "execute",
      arguments: { code: "return await tools.sapiom.ping({})" },
    },
  ];
  await send(
    session.id,
    first,
    "Run the harmless fixture actions. Preserve USER_HISTORY_CANARY.",
  );
  const initial = workIn("initial");
  mark(
    "rootDiscoveryDisabled",
    !nativeSystem(initial[0].body).includes(rootRule) &&
      !nativeSystem(initial[0].body).includes("ROOT_CLAUDE_CANARY"),
  );
  mark(
    "nativeMcpInstructionsPresent",
    nativeSystem(initial[0].body).includes("MCP_INSTRUCTION_CANARY"),
  );
  mark(
    "skillCatalogPresent",
    nativeSystem(initial[0].body).includes("context-fixture"),
  );
  mark(
    "explicitInstructionsRereadDuringTurn",
    nativeSystem(initial[1].body).includes("EXPLICIT_GUIDE_V2"),
  );
  mark(
    "nestedInstructionsLoadedByRead",
    JSON.stringify(initial).includes(nestedRule),
  );
  mark(
    "skillBodyRetainsDiscoveredRevision",
    JSON.stringify(initial).includes("SKILL_BODY_V1") &&
      !JSON.stringify(initial).includes("SKILL_BODY_V2"),
  );
  mark(
    "mcpToolExecuted",
    JSON.stringify(initial).includes("MCP_RESULT_CANARY") &&
      JSON.stringify(initial[0].body.tools).includes("MCP_TOOL_CANARY"),
  );
  await writeFile(join(cwd, "nested", "AGENTS.md"), "NESTED_RULE_V2");
  phase = "unchanged";
  actions = [
    { name: "read", arguments: { filePath: join(cwd, "nested", "index.ts") } },
  ];
  await send(session.id, compose(context()), "Read the same fixture again.");
  mark(
    "nativeNestedRevisionRemainsOldInHistory",
    !JSON.stringify(workIn(phase)).includes("NESTED_RULE_V2"),
  );
  phase = "changed";
  const changed = compose(context("Orchid", "V2"));
  await send(
    session.id,
    changed,
    "Acknowledge the selected agent and new guidance.",
  );
  mark(
    "newRequestHasUpdatedGuidance",
    nativeSystem(workIn(phase)[0].body).includes("PROFILE_V2"),
  );
  mark(
    "oldSystemNotCurrent",
    !nativeSystem(workIn(phase)[0].body).includes("PROFILE_V1"),
  );
  mark(
    "nativeHistoryRetained",
    JSON.stringify(workIn(phase)[0].body.input).includes("USER_HISTORY_CANARY"),
  );
  phase = "recovery";
  const recovered = recover(changed.system);
  await send(
    session.id,
    recovered,
    "Continue accepted Orchid work using saved results.",
  );
  mark(
    "recoveryRetainsAcceptedContext",
    recovered.system.slice(
      recovered.system.indexOf("\n\nStudioAssistantContext/v1"),
    ) ===
      changed.system.slice(
        changed.system.indexOf("\n\nStudioAssistantContext/v1"),
      ),
  );
  phase = "compaction";
  await request(`/session/${session.id}/summarize`, {
    providerID: "sapiom",
    modelID: "gpt-luna",
    auto: true,
  });
  history = await request(`/session/${session.id}/message`);
  mark(
    "nativeSyntheticContinuationCreated",
    history.some((m) =>
      m.parts.some((p) => p.synthetic && p.metadata?.compaction_continue),
    ),
  );
  mark(
    "compactionRestoresAcceptedSystem",
    workIn(phase).some((r) => nativeSystem(r.body).includes(recovered.system)),
  );
  mark(
    "historyCompletionParserStillWorks",
    openCodeCompletionTokens(history).get(
      history.findLast((m) =>
        m.parts.some((p) => p.synthetic && p.metadata?.compaction_continue),
      ).info.id,
    ) === recovered.system.split("\n")[0].split(":")[1],
  );
  const priorIds = history.map((m) => m.info.id);
  const priorSystems = new Map(history.map((m) => [m.info.id, m.info.system]));
  await runtime.close();
  runtime = undefined;
  projected = true;
  runtime = await start();
  mark(
    "restartPreservesMessageIdentity",
    JSON.stringify(
      (await request(`/session/${session.id}/message`)).map((m) => m.info.id),
    ) === JSON.stringify(priorIds),
  );
  phase = "projected";
  const projectedPrompt = compose(context("Orchid", "V2"));
  await send(session.id, projectedPrompt, "Acknowledge without tools.");
  const wire = nativeSystem(workIn(phase)[0].body);
  mark(
    "projectionPlacesStableGuidanceFirst",
    wire.indexOf("PROFILE_V2") >= 0 &&
      wire.indexOf("PROFILE_V2") < wire.indexOf("StudioAssistantResult/v2:"),
  );
  mark(
    "projectionPreservesExactCompletion",
    wire.includes(projectedPrompt.system.split("\n")[0]),
  );
  mark(
    "projectionKeepsSystemAuthority",
    workIn(phase)[0].body.input.some(
      (item) =>
        ["developer", "system"].includes(item.role) &&
        JSON.stringify(item).includes("PROFILE_V2"),
    ),
  );
  history = await request(`/session/${session.id}/message`);
  mark(
    "projectionDoesNotRewriteSavedEnvelope",
    history.some((m) => m.info.system === projectedPrompt.system) &&
      [...priorSystems].every(([id, system]) =>
        history.some((m) => m.info.id === id && m.info.system === system),
      ),
  );
  const token = projectedPrompt.system.split("\n")[0].split(":")[1];
  const answer = history
    .at(-1)
    .parts.filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  mark(
    "projectedAnswerUsesAcceptedToken",
    parseOpenCodeCompletion(answer, token)?.status === "finished",
  );
  mark(
    "wrongCompletionTokenRejected",
    !parseOpenCodeCompletion(answer, "00000000-0000-0000-0000-000000000000"),
  );
  phase = "projected-compaction";
  await request(`/session/${session.id}/summarize`, {
    providerID: "sapiom",
    modelID: "gpt-luna",
    auto: true,
  });
  mark(
    "projectionWorksAfterNativeCompaction",
    workIn(phase).some((r) => {
      const system = nativeSystem(r.body);
      return (
        system.indexOf("PROFILE_V2") >= 0 &&
        system.indexOf("PROFILE_V2") <
          system.indexOf(projectedPrompt.system.split("\n")[0])
      );
    }),
  );
  phase = "other-session";
  const other = await request("/session", {
    title: "Independent context assessment",
  });
  await send(
    other.id,
    compose({
      ...context("Cedar"),
      session: { ...context().session, id: "studio-other" },
    }),
    "Acknowledge this separate conversation.",
  );
  mark(
    "sameFolderConversationIsolation",
    !JSON.stringify(workIn(phase)).includes("USER_HISTORY_CANARY"),
  );
  completed = true;
} finally {
  await runtime?.close();
  bridge.closeAllConnections();
  await new Promise((resolve) => bridge.close(resolve));
  const report = {
    checkedAt: new Date().toISOString(),
    sdkHead: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sdk,
      encoding: "utf8",
    }).trim(),
    runtimePin: JSON.parse(
      await readFile(join(sdk, "packages/opencode/package.json")),
    ).dependencies["opencode-ai"],
    composer: draft ? "SAP-3328 actual draft" : "standalone fixture envelope",
    evidence:
      "pinned native runtime; controlled provider; synthetic usage is not a cache measurement",
    checks,
    completed,
    requests,
    history,
  };
  const serialized =
    JSON.stringify(report, null, 2).replaceAll(root, "<fixture-root>") + "\n";
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, serialized);
  console.log(
    JSON.stringify({
      checks,
      requests: requests.length,
      output,
      sha256: digest(serialized),
    }),
  );
  await rm(root, { recursive: true, force: true });
}
