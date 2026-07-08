/**
 * Registry behavior: enumeration and lookup are driven purely by the
 * adapter list, adapters all satisfy the shared contract, and external
 * adapters expose no spawn path (at runtime and in the type system).
 */
import {
  createHarnessRegistry,
  getAdapter,
  HARNESS_ADAPTERS,
  listAdapters,
  UnknownHarnessError,
} from "../index.js";
import type {
  EmbeddedHarnessAdapter,
  ExternalHarnessAdapter,
  HarnessAdapter,
  HarnessId,
} from "../index.js";
import { conductorAdapter } from "../conductor.js";

const EXPECTED_IDS: HarnessId[] = [
  "claude-code",
  "codex",
  "pi",
  "opencode",
  "conductor",
];

describe("harness registry", () => {
  it("lists the built-in adapters in registration order", () => {
    expect(listAdapters().map((a) => a.id)).toEqual(EXPECTED_IDS);
    expect(listAdapters()).toEqual([...HARNESS_ADAPTERS]);
  });

  it("resolves every listed adapter by id, to the same instance", () => {
    for (const adapter of listAdapters()) {
      expect(getAdapter(adapter.id)).toBe(adapter);
    }
  });

  it("throws a typed UnknownHarnessError for unknown ids", () => {
    expect(() => getAdapter("not-a-harness")).toThrow(UnknownHarnessError);
    expect(() => getAdapter("not-a-harness")).toThrow(
      /Unknown harness: "not-a-harness"/,
    );
    try {
      getAdapter("not-a-harness");
      throw new Error("expected getAdapter to throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "UNKNOWN_HARNESS" });
      // The error names the known ids so callers can self-correct.
      expect((error as Error).message).toContain("claude-code");
    }
  });

  it("rejects duplicate adapter ids at construction time", () => {
    expect(() =>
      createHarnessRegistry([...HARNESS_ADAPTERS, HARNESS_ADAPTERS[0]]),
    ).toThrow(/Duplicate harness adapter id: claude-code/);
  });

  it("a fictional adapter appears everywhere with a single registry entry", () => {
    // If this test ever needs more than the one-line array change below to
    // make the adapter enumerable and resolvable, the registry has stopped
    // being data-driven.
    const fictional: EmbeddedHarnessAdapter = {
      id: "fictional" as HarnessId,
      label: "Fictional Harness",
      mode: "embedded",
      promptDelivery: "inline",
      experimental: true,
      launchCommand: (cfg) => ({
        command: "fictional",
        args: [],
        env: { ...cfg.env },
      }),
      installMcpPrompt: () => "Install @sapiom/mcp for Fictional Harness.",
      detectInstalled: async () => false,
    };

    const registry = createHarnessRegistry([...HARNESS_ADAPTERS, fictional]);

    expect(registry.list()).toHaveLength(HARNESS_ADAPTERS.length + 1);
    expect(registry.list()[registry.list().length - 1]).toBe(fictional);
    expect(registry.get("fictional")).toBe(fictional);
    // The built-ins are untouched.
    for (const adapter of HARNESS_ADAPTERS) {
      expect(registry.get(adapter.id)).toBe(adapter);
    }
  });

  it("returns a frozen adapter list", () => {
    const list = listAdapters();
    expect(Object.isFrozen(list)).toBe(true);
  });
});

describe("adapter contract", () => {
  it.each(listAdapters().map((adapter) => [adapter.id, adapter] as const))(
    "%s has the full HarnessAdapter shape",
    async (_id, adapter) => {
      expect(EXPECTED_IDS).toContain(adapter.id);
      expect(typeof adapter.label).toBe("string");
      expect(adapter.label.length).toBeGreaterThan(0);
      expect(["embedded", "external"]).toContain(adapter.mode);
      expect(["inline", "post-launch"]).toContain(adapter.promptDelivery);
      if (adapter.experimental !== undefined) {
        expect(typeof adapter.experimental).toBe("boolean");
      }

      const prompt = adapter.installMcpPrompt();
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(0);
      // Every install prompt names the Sapiom MCP server package.
      expect(prompt).toContain("@sapiom/mcp");

      const installed = await adapter.detectInstalled();
      expect(typeof installed).toBe("boolean");
    },
  );

  it("embedded adapters expose launchCommand; external adapters have no spawn path", () => {
    expect.hasAssertions();
    for (const adapter of listAdapters()) {
      if (adapter.mode === "embedded") {
        expect(typeof adapter.launchCommand).toBe("function");
        const launch = adapter.launchCommand({
          env: { PATH: "/usr/bin", TERM: "xterm-256color" },
        });
        expect(typeof launch.command).toBe("string");
        expect(launch.command.length).toBeGreaterThan(0);
        expect(Array.isArray(launch.args)).toBe(true);
        // The provided environment survives (adapters may add to it).
        expect(launch.env).toMatchObject({
          PATH: "/usr/bin",
          TERM: "xterm-256color",
        });
      } else {
        expect("launchCommand" in adapter).toBe(false);
        expect(adapter.launchCommand).toBeUndefined();
      }
    }
  });

  it("marks exactly the scaffold adapters as experimental", () => {
    const experimentalIds = listAdapters()
      .filter((adapter) => adapter.experimental === true)
      .map((adapter) => adapter.id);
    expect(experimentalIds).toEqual(["codex", "pi", "opencode"]);
    expect(getAdapter("claude-code").experimental).toBeFalsy();
    expect(getAdapter("conductor").experimental).toBeFalsy();
  });

  it("conductor is the external, spawn-free adapter", () => {
    const conductor = getAdapter("conductor");
    expect(conductor.mode).toBe("external");
    expect("launchCommand" in conductor).toBe(false);
  });
});

describe("type-level enforcement", () => {
  it("rejects a launchCommand on an external adapter", () => {
    // `launchCommand` is typed `never` on ExternalHarnessAdapter, so a
    // spawn path is a compile error, not a convention.
    const invalid: ExternalHarnessAdapter = {
      ...conductorAdapter,
      // @ts-expect-error — external adapters must not define a spawn path.
      launchCommand: () => ({ command: "x", args: [], env: {} }),
    };
    void invalid;
    expect(true).toBe(true);
  });

  it("requires narrowing on mode before calling launchCommand", () => {
    // Via getAdapter() so the compiler sees the full union, not conductor.
    const adapter: HarnessAdapter = getAdapter("conductor");
    // @ts-expect-error — launchCommand may be absent until mode is narrowed.
    const call = () => adapter.launchCommand({ env: {} });
    void call;

    if (adapter.mode === "embedded") {
      // Narrowed: this compiles (and is unreachable for conductor).
      adapter.launchCommand({ env: {} });
    }
    expect(adapter.mode).toBe("external");
  });
});
