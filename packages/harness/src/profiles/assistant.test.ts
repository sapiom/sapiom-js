import { afterEach, expect, it, vi } from "vitest";
import type { ResolvedEnvironment } from "@sapiom/mcp/auth";
import { assistantProfile, assistantProjectRole } from "./assistant.js";
import { DEFAULT_SYSTEM_PROMPT } from "./default.js";

const environment = {
  name: "dev",
  apiURL: "http://127.0.0.1:3000",
  appURL: "http://127.0.0.1:2999",
  services: {},
  credentials: null,
} as ResolvedEnvironment;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("records the actual source and content revision, including the bundled offline fallback", async () => {
  vi.stubEnv("SAPIOM_HARNESS_PROMPT_FETCH_DISABLED", "0");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("Served Studio guidance")),
  );
  const served = await assistantProfile(environment);
  expect(served.source).toBe("http://127.0.0.1:3000/v1/harness/system-prompt");
  expect(served.text).toBe("Served Studio guidance");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const fallback = await assistantProfile(environment);
  expect(fallback).toMatchObject({
    source: "bundled:studio-profile",
    text: DEFAULT_SYSTEM_PROMPT,
    status: "available",
    required: true,
  });
  expect(fallback.revision).not.toBe(served.revision);
});

it("uses the host's supplied profile and keeps an empty/failed override recoverable through the bundle", async () => {
  expect(
    (await assistantProfile(environment, async () => "Custom profile")).text,
  ).toBe("Custom profile");
  for (const load of [
    async () => "",
    async () => {
      throw new Error("missing");
    },
  ])
    expect((await assistantProfile(environment, load)).source).toBe(
      "bundled:studio-profile",
    );
  const role = assistantProjectRole();
  expect(role.text).toContain("ordinary writable coding agent");
  expect(role.text).not.toContain("this project has sapiom");
});

it("records fallback provenance separately from content and preserves it in accepted versions", async () => {
  const { retainAssistantGuidance } =
    await import("../core/assistant-sources.js");
  const scope = "a".repeat(64);
  vi.stubEnv("SAPIOM_HARNESS_PROMPT_FETCH_DISABLED", "1");
  const deliberate = retainAssistantGuidance(
    await assistantProfile(environment),
    scope,
  );
  vi.stubEnv("SAPIOM_HARNESS_PROMPT_FETCH_DISABLED", "0");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("private failure details")),
  );
  const fallback = retainAssistantGuidance(
    await assistantProfile(environment),
    scope,
  );
  expect(fallback.version.contentHash).toBe(deliberate.version.contentHash);
  expect(fallback.version.revision).not.toBe(deliberate.version.revision);
  expect(fallback.version.fallback).toEqual({
    fromSource: "http://127.0.0.1:3000/v1/harness/system-prompt",
    reason: "Profile endpoint did not supply usable guidance",
  });
  expect(JSON.stringify(fallback)).not.toContain("private failure details");
});

it.each(["fetch", "override"])(
  "propagates cancellation during %s rather than selecting a fallback",
  async (mode) => {
    vi.stubEnv("SAPIOM_HARNESS_PROMPT_FETCH_DISABLED", "0");
    const controller = new AbortController();
    const cancelled = new Error("cancelled profile");
    const wait = (signal?: AbortSignal) =>
      new Promise<string>((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(signal!.reason), {
          once: true,
        }),
      );
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init) => wait(init.signal)),
    );
    const pending = assistantProfile(
      environment,
      mode === "override" ? wait : undefined,
      controller.signal,
    );
    const rejected = expect(pending).rejects.toBe(cancelled);
    controller.abort(cancelled);
    await rejected;
  },
);
