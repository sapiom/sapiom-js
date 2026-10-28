import { inspect } from "node:util";
import { Transport } from "./index.js";
import { Sandbox } from "../sandboxes/index.js";
import { Repository } from "../repositories/index.js";

const API_KEY = "sk_test_serialization_key";
const RESUME_TOKEN = "resume_test_serialization_token";

function transport(): Transport {
  return new Transport({
    apiKey: API_KEY,
    resumeToken: RESUME_TOKEN,
    coreBaseUrl: "https://api.sapiom.ai",
    fetch: (() =>
      Promise.resolve(new Response("{}"))) as typeof globalThis.fetch,
  });
}

/** Everything `console.log` writes for `value`. */
function consoleOutput(value: unknown): string {
  const spy = jest.spyOn(console, "log").mockImplementation(() => {});
  try {
    console.log(value);
    return spy.mock.calls
      .flat()
      .map((arg) => (typeof arg === "string" ? arg : inspect(arg)))
      .join("\n");
  } finally {
    spy.mockRestore();
  }
}

describe("Transport secrets stay out of serialized handles", () => {
  const handles: Array<[string, () => unknown]> = [
    ["a Transport", () => transport()],
    ["a Sandbox.attach handle", () => Sandbox.attach("sb", {}, transport())],
    [
      "a Repository.attach handle",
      () =>
        Repository.attach("repo", "https://git.example/repo.git", transport()),
    ],
  ];

  it.each(handles)("JSON.stringify of %s", (_label, build) => {
    const out = JSON.stringify(build());
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain(RESUME_TOKEN);
  });

  it.each(handles)("util.inspect of %s", (_label, build) => {
    const out = inspect(build(), { depth: 10, showHidden: true });
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain(RESUME_TOKEN);
  });

  it.each(handles)("console.log of %s", (_label, build) => {
    const out = consoleOutput(build());
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain(RESUME_TOKEN);
  });

  it("keeps the non-secret settings in the serialized form", () => {
    expect(JSON.parse(JSON.stringify(transport()))).toEqual({
      capabilityDelivery: "legacy",
      coreBaseUrl: "https://api.sapiom.ai",
    });
  });
});

describe("Transport secrets stay usable", () => {
  it("still exposes the resume token to capability modules", () => {
    expect(transport().resumeToken).toBe(RESUME_TOKEN);
  });

  it("carries both secrets into a transport derived with withAttribution", async () => {
    let sent: Record<string, string> = {};
    const base = new Transport({
      apiKey: API_KEY,
      resumeToken: RESUME_TOKEN,
      fetch: ((_input: unknown, init: RequestInit = {}) => {
        sent = init.headers as Record<string, string>;
        return Promise.resolve(new Response("{}"));
      }) as typeof globalThis.fetch,
    });

    const derived = base.withAttribution({ traceId: "trace_1" });
    await derived.fetch("https://api.sapiom.ai/v1/memory");

    expect(derived.resumeToken).toBe(RESUME_TOKEN);
    expect(sent["x-sapiom-api-key"]).toBe(API_KEY);
  });
});
