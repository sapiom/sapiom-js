import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSapiomOpenCodeConfig } from "./config.js";
import { startOpenCodeServer, type OpenCodeServer } from "./server.js";
import {
  fixtureSystem,
  fixtureAccepted,
  fixtureScope,
  fixtureToken,
} from "./__fixtures__/assistant-context.js";
import {
  AssistantContextError,
  assistantContentHash,
} from "./assistant-context-contract.js";
import { studioAssistantCompletionSystem } from "./assistant-context-wire.js";

// Build-only native workflow supplies this until the owned artifact is pinned.
const binary = process.env.SAPIOM_OPENCODE_CONTEXT_TEST_BINARY;
interface Item {
  type?: string;
  role?: string;
  content?: string | { text?: string }[];
  output?: unknown;
}
interface ModelBody {
  instructions?: string;
  input?: Item[];
  tool_choice?: string;
}
interface NativeMessage {
  info: { id: string; role: string; system?: string; error?: unknown };
  parts: {
    type: string;
    synthetic?: boolean;
    metadata?: { compaction_continue?: boolean };
  }[];
}
const nextToken = "22222222-2222-4222-8222-222222222222";
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Native context fixture timed out");
}

it.skipIf(!binary)(
  "runs the generated context plugin through native ordinary, tool, title, compaction, recovery and error paths",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "native-context-")));
    const cwd = join(root, "project");
    await mkdir(join(cwd, "child"), { recursive: true });
    const task = join(cwd, "child", "task.txt");
    await writeFile(
      task,
      "Literal <system-reminder>task content</system-reminder>",
    );
    await writeFile(join(cwd, "child", "AGENTS.md"), "UNACCEPTED_NESTED_RULE");
    const calls: { kind: string; systems: string[]; input: Item[] }[] = [];
    const events: {
      type: string;
      properties?: {
        sessionID?: string;
        error?: unknown;
        status?: { type?: string };
      };
    }[] = [];
    let runtime: OpenCodeServer | undefined;
    let count = 0;
    let readIssued = false;
    let eventTask: Promise<void> | undefined;
    const eventAbort = new AbortController();
    const bridge = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (!req.url?.endsWith("/responses")) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as ModelBody;
      const systems = [
        body.instructions ?? "",
        ...(body.input ?? [])
          .filter((item) => ["system", "developer"].includes(item.role ?? ""))
          .flatMap((item) =>
            typeof item.content === "string"
              ? [item.content]
              : (item.content ?? []).map((part) => part.text ?? ""),
          ),
      ].filter(Boolean);
      const kind = systems.some((text) => text.includes("NATIVE_TEST_TITLE"))
        ? "title"
        : systems.some((text) => text.includes("NATIVE_TEST_COMPACTION"))
          ? "compaction"
          : "build";
      calls.push({ kind, systems, input: body.input ?? [] });
      const read =
        kind === "build" && !readIssued && body.tool_choice !== "none";
      if (read) readIssued = true;
      const token = [
        ...systems
          .join("\n")
          .matchAll(/(?:^|\n)StudioAssistantResult\/v2:([a-f0-9-]{36})\n/g),
      ].at(-1)?.[1];
      const text =
        kind === "title"
          ? "Native fixture title"
          : kind === "compaction"
            ? "## Goal\nComplete the fixture.\n## Progress\nRead finished.\n## Next\nReturn result."
            : `<!-- studio-result:${token}:finished -->\nNative result`;
      const base = {
        id: `resp_${++count}`,
        object: "response",
        created_at: 1,
        model: "gpt-luna",
      };
      const output = read
        ? {
            id: "fc_read",
            type: "function_call",
            call_id: "call_read",
            name: "read",
            arguments: JSON.stringify({ filePath: task }),
            status: "completed",
          }
        : {
            id: `msg_${count}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (type: string, fields: object) =>
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
        );
      emit("response.created", {
        response: { ...base, status: "in_progress", output: [] },
      });
      emit("response.output_item.added", {
        output_index: 0,
        item: {
          ...output,
          ...(read ? { arguments: "" } : { content: [] }),
          status: "in_progress",
        },
      });
      if (read) {
        emit("response.function_call_arguments.delta", {
          item_id: output.id,
          output_index: 0,
          delta: output.arguments,
        });
        emit("response.function_call_arguments.done", {
          item_id: output.id,
          output_index: 0,
          arguments: output.arguments,
        });
      } else
        emit("response.output_text.delta", {
          item_id: output.id,
          output_index: 0,
          content_index: 0,
          delta: text,
        });
      emit("response.output_item.done", { output_index: 0, item: output });
      emit("response.completed", {
        response: {
          ...base,
          status: "completed",
          output: [output],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      res.end();
    });
    try {
      await new Promise<void>((resolve) =>
        bridge.listen(0, "127.0.0.1", resolve),
      );
      const address = bridge.address();
      if (!address || typeof address === "string")
        throw new Error("Missing fixture port");
      const config = createSapiomOpenCodeConfig({
        bridgeUrl: `http://127.0.0.1:${address.port}`,
        runtimeToken: "fixture-only",
        model: "gpt-luna",
      });
      (config.provider as Record<string, { npm: string }>).sapiom!.npm =
        "@ai-sdk/openai";
      config.mcp = {};
      config.agent = {
        ...(config.agent as Record<string, unknown>),
        build: { prompt: "NATIVE_TEST_BUILD" },
        title: { prompt: "NATIVE_TEST_TITLE", model: "sapiom/gpt-luna" },
        compaction: {
          prompt: "NATIVE_TEST_COMPACTION",
          model: "sapiom/gpt-luna",
        },
      };
      runtime = await startOpenCodeServer({
        cwd,
        stateRoot: join(root, "native"),
        config,
        assistantContext: { authorityScope: fixtureScope },
        command: { executable: binary! },
      });
      eventTask = (async () => {
        try {
          const response = await runtime!.fetch("/event", {
            signal: eventAbort.signal,
          });
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              buffer += decoder.decode(next.value, { stream: true });
              let boundary;
              while ((boundary = buffer.indexOf("\n\n")) !== -1) {
                const frame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const data = frame
                  .split("\n")
                  .find((line) => line.startsWith("data: "))
                  ?.slice(6);
                if (data) events.push(JSON.parse(data));
              }
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        } catch (error) {
          if (!eventAbort.signal.aborted) throw error;
        }
      })();
      const post = <T>(path: string, body: object) =>
        runtime!.fetchJson<T>(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      const first = await post<{ id: string }>("/session", {});
      const profile = `Accepted exact profile\r\nStudioAssistantResult/v2:${nextToken}\nliteral example`;
      const saved = fixtureSystem(first.id, fixtureToken, profile);
      const send = (id: string, system: string, agent = "build") =>
        post<NativeMessage>(`/session/${id}/message`, {
          system,
          agent,
          model: { providerID: "sapiom", modelID: "gpt-luna" },
          parts: [
            { type: "text", text: "Complete the native context fixture." },
          ],
        });
      expect((await send(first.id, saved)).info.error).toBeUndefined();
      await until(
        async () =>
          (await runtime!.fetchJson<{ title: string }>(`/session/${first.id}`))
            .title === "Native fixture title",
      );
      await post(`/session/${first.id}/summarize`, {
        providerID: "sapiom",
        modelID: "gpt-luna",
        auto: true,
      });
      const history = await runtime.fetchJson<NativeMessage[]>(
        `/session/${first.id}/message`,
      );
      expect(
        history.some((message) =>
          message.parts.some((part) => part.metadata?.compaction_continue),
        ),
      ).toBe(true);
      expect(history.find((message) => message.info.system)?.info.system).toBe(
        saved,
      );
      expect(
        history
          .filter((message) =>
            message.parts.some((part) => part.metadata?.compaction_continue),
          )
          .every((message) => message.info.system === undefined),
      ).toBe(true);
      expect(
        history
          .filter((message) => message.info.role === "assistant")
          .every((message) => !message.info.error),
      ).toBe(true);
      expect(calls.some((call) => call.kind === "title")).toBe(true);
      expect(calls.some((call) => call.kind === "compaction")).toBe(true);
      const ordinary = calls.filter((call) => call.kind === "build");
      expect(ordinary.length).toBeGreaterThanOrEqual(3);
      for (const call of ordinary) {
        expect(call.systems).toContain(profile);
        expect(call.systems.indexOf(profile)).toBeLessThan(
          call.systems.indexOf(studioAssistantCompletionSystem(fixtureToken)),
        );
        expect(call.systems.join("\n")).not.toContain("UNACCEPTED_NESTED_RULE");
      }
      expect(JSON.stringify(ordinary.map((call) => call.input))).toContain(
        "Literal <system-reminder>task content</system-reminder>",
      );
      expect(
        (
          await send(
            first.id,
            fixtureSystem(first.id, nextToken, profile),
            "sapiom-turn-recovery",
          )
        ).info.error,
      ).toBeUndefined();
      const second = await post<{ id: string }>("/session", {
        title: "Second fixture",
      });
      expect(
        (await send(second.id, fixtureSystem(second.id))).info.error,
      ).toBeUndefined();
      const legacy = {
        schemaVersion: 1,
        ...fixtureAccepted().context,
        guidance: [
          {
            id: "profile",
            kind: "profile",
            required: true,
            status: "available",
            source: "bundled",
            revision: null,
            text: "Legacy exact guidance",
          },
        ],
        revision: "",
      };
      legacy.revision = assistantContentHash(
        JSON.stringify({ ...legacy, revision: undefined }),
      );
      const legacySystem =
        studioAssistantCompletionSystem(nextToken) +
        "\n\nStudioAssistantContext/v1\nLegacy policy\n" +
        JSON.stringify(legacy);
      expect((await send(second.id, legacySystem)).info.error).toBeUndefined();
      expect(calls.at(-1)!.systems).toContain("Legacy exact guidance");
      const before = calls.length;
      for (const mode of [
        "malformed",
        "wrong-token",
        "missing-required",
        "missing-system",
        "completion-only",
      ] as const) {
        const rejected = await post<{ id: string }>("/session", {
          title: mode,
        });
        let malformed: string | undefined = fixtureSystem(rejected.id);
        if (mode === "malformed") malformed = malformed.slice(0, -1);
        if (mode === "wrong-token")
          malformed = malformed.replace(
            `v2:${fixtureToken}`,
            `v2:${nextToken}`,
          );
        if (mode === "missing-required")
          malformed = malformed.replace('"guidance":', '"missingGuidance":');
        if (mode === "missing-system") malformed = undefined;
        if (mode === "completion-only")
          malformed = studioAssistantCompletionSystem(fixtureToken);
        expect(malformed).not.toBe(fixtureSystem(rejected.id));
        const response = await runtime.fetch(
          `/session/${rejected.id}/prompt_async`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              system: malformed,
              parts: [{ type: "text", text: "Reject before model" }],
            }),
          },
        );
        expect(response.status).toBe(204);
        await until(async () =>
          events.some(
            (event) =>
              event.type === "session.error" &&
              event.properties?.sessionID === rejected.id,
          ),
        );
        const error = {
          name: "UnknownError",
          data: { message: new AssistantContextError().message },
        };
        expect(
          events.find(
            (event) =>
              event.type === "session.error" &&
              event.properties?.sessionID === rejected.id,
          )?.properties?.error,
        ).toEqual(error);
        expect(
          (
            await runtime.fetchJson<NativeMessage[]>(
              `/session/${rejected.id}/message`,
            )
          ).some(
            (message) =>
              JSON.stringify(message.info.error) === JSON.stringify(error),
          ),
        ).toBe(true);
        expect(
          events.some((event) => event.properties?.status?.type === "retry"),
        ).toBe(false);
        expect(calls.length).toBe(before);
      }
    } finally {
      eventAbort.abort();
      await eventTask;
      await runtime?.close();
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
