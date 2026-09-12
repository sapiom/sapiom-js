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
