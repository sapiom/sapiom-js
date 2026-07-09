/**
 * HarnessAdapter registry: enumeration, lookup, mode contract, and
 * per-adapter metadata shape.
 */
import { describe, expect, it } from "vitest";
import {
  HARNESS_ADAPTER_INFOS,
  createHarnessAdapterRegistry,
  getHarnessAdapter,
  listHarnessAdapters,
  UnknownHarnessAdapterError,
} from "./registry.js";
import { HarnessError } from "../errors.js";
import type { EmbeddedHarnessAdapterInfo, ExternalHarnessAdapterInfo, HarnessAdapterId } from "./adapter.js";

const EXPECTED_IDS: HarnessAdapterId[] = [
  "claude-code",
  "codex",
  "pi",
  "opencode",
  "conductor",
];

describe("harness adapter registry — built-in adapters", () => {
  it("lists adapters in registration order", () => {
    expect(listHarnessAdapters().map((a) => a.id)).toEqual(EXPECTED_IDS);
  });

  it("list() returns the same frozen array each time", () => {
    const list = listHarnessAdapters();
    expect(Object.isFrozen(list)).toBe(true);
    expect(listHarnessAdapters()).toBe(list);
  });

  it("HARNESS_ADAPTER_INFOS has the same entries as listHarnessAdapters()", () => {
    expect([...listHarnessAdapters()]).toEqual([...HARNESS_ADAPTER_INFOS]);
  });

  it("resolves every listed adapter by id, to the same instance", () => {
    for (const adapter of listHarnessAdapters()) {
      expect(getHarnessAdapter(adapter.id)).toBe(adapter);
    }
  });
});

describe("harness adapter registry — lookup errors", () => {
  it("throws UnknownHarnessAdapterError for an unknown id", () => {
    expect(() => getHarnessAdapter("not-a-harness")).toThrow(UnknownHarnessAdapterError);
    expect(() => getHarnessAdapter("not-a-harness")).toThrow(/Unknown harness adapter/);
    expect(() => getHarnessAdapter("not-a-harness")).toThrow(/"not-a-harness"/);
  });

  it("UnknownHarnessAdapterError names known adapters in the message", () => {
    let caught: Error | undefined;
    try {
      getHarnessAdapter("phantom");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(UnknownHarnessAdapterError);
    expect(caught!.message).toContain("claude-code");
    expect(caught!.message).toContain("conductor");
  });

  it("UnknownHarnessAdapterError has code UNKNOWN_HARNESS_ADAPTER", () => {
    let caught: unknown;
    try {
      getHarnessAdapter("phantom");
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "UNKNOWN_HARNESS_ADAPTER" });
  });

  it("UnknownHarnessAdapterError is an instanceof HarnessError", () => {
    let caught: unknown;
    try {
      getHarnessAdapter("phantom");
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof HarnessError).toBe(true);
  });
});

describe("createHarnessAdapterRegistry — custom registries", () => {
  it("rejects duplicate adapter ids at construction time", () => {
    expect(() =>
      createHarnessAdapterRegistry([...HARNESS_ADAPTER_INFOS, HARNESS_ADAPTER_INFOS[0]]),
    ).toThrow(/Duplicate harness adapter id/);
  });

  it("a new adapter is enumerable and resolvable with a single registration entry", () => {
    const fictional: EmbeddedHarnessAdapterInfo = {
      id: "fictional" as HarnessAdapterId,
      label: "Fictional Harness",
      mode: "embedded",
      experimental: true,
      installMcpPrompt: () => "Install @sapiom/mcp for Fictional Harness.",
      detectInstalled: async () => false,
    };

    const registry = createHarnessAdapterRegistry([...HARNESS_ADAPTER_INFOS, fictional]);
    expect(registry.list()).toHaveLength(HARNESS_ADAPTER_INFOS.length + 1);
    expect(registry.list()[registry.list().length - 1]).toBe(fictional);
    expect(registry.get("fictional")).toBe(fictional);
    // Built-ins are untouched.
    for (const adapter of HARNESS_ADAPTER_INFOS) {
      expect(registry.get(adapter.id)).toBe(adapter);
    }
  });
});

describe("adapter contract — shape of every built-in entry", () => {
  it.each(listHarnessAdapters().map((adapter) => [adapter.id, adapter] as const))(
    "%s has the full HarnessAdapterInfo shape",
    async (_id, adapter) => {
      expect(typeof adapter.id).toBe("string");
      expect(adapter.id.length).toBeGreaterThan(0);

      expect(typeof adapter.label).toBe("string");
      expect(adapter.label.length).toBeGreaterThan(0);

      expect(["embedded", "external"]).toContain(adapter.mode);

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

  it("embedded adapters have mode 'embedded'; external adapters have mode 'external'", () => {
    for (const adapter of listHarnessAdapters()) {
      if (adapter.id === "conductor") {
        expect(adapter.mode).toBe("external");
      } else {
        expect(adapter.mode).toBe("embedded");
      }
    }
  });

  it("conductor is the only external, spawn-free adapter", () => {
    const conductor = getHarnessAdapter("conductor");
    expect(conductor.mode).toBe("external");
    // External adapter has no launchCommand field.
    expect("launchCommand" in conductor).toBe(false);
  });

  it("marks exactly the scaffold adapters as experimental", () => {
    const experimentalIds = listHarnessAdapters()
      .filter((a) => a.experimental === true)
      .map((a) => a.id);
    expect(experimentalIds).toEqual(["codex", "pi", "opencode"]);
    expect(getHarnessAdapter("claude-code").experimental).toBeFalsy();
    expect(getHarnessAdapter("conductor").experimental).toBeFalsy();
  });
});

describe("mode-based type narrowing", () => {
  it("narrowing on mode gives embedded access on embedded adapters", () => {
    const adapter = getHarnessAdapter("claude-code");
    if (adapter.mode === "embedded") {
      // This is reachable — claude-code is embedded.
      expect(adapter.mode).toBe("embedded");
    } else {
      throw new Error("claude-code should be embedded");
    }
  });

  it("external adapters cannot satisfy the embedded shape's mode literal", () => {
    const adapter = getHarnessAdapter("conductor");
    // TypeScript enforces this at compile time; at runtime the mode value says external.
    expect(adapter.mode).toBe("external");
    const narrowed = adapter as ExternalHarnessAdapterInfo;
    expect(narrowed.mode).toBe("external");
  });
});
