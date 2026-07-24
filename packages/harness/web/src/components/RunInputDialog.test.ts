/**
 * Unit tests for RunInputDialog helper functions:
 *  - buildSkeleton: derives a JSON skeleton from an entry node's input fields
 *  - buildFieldHint: formats the field hint line
 *  - computeInitialValue: applies the prefill priority (last-used > skeleton > {})
 *  - loadLastInput / saveLastInput: localStorage persistence helpers
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CanvasGraph } from "../lib/canvas-graph";
import {
  buildSkeleton,
  buildFieldHint,
  computeInitialValue,
  loadLastInput,
  saveLastInput,
} from "./RunInputDialog";

// ---------------------------------------------------------------------------
// localStorage mock (vitest runs in Node, not jsdom)
// ---------------------------------------------------------------------------

function makeLocalStorageMock(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const key of Object.keys(store)) delete store[key];
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  } as Storage;
}

// Replace global localStorage with the mock before each test suite that uses it.
function setupLocalStorageMock(): { store: Storage } {
  const store = makeLocalStorageMock();
  vi.stubGlobal("localStorage", store);
  return { store };
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

/** A minimal CanvasGraph with an entry node that has two input fields. */
function makeGraph(overrides?: Partial<CanvasGraph>): CanvasGraph {
  return {
    name: "test-workflow",
    entry: "entry-node",
    nodes: [
      {
        id: "entry-node",
        kind: "entry",
        label: "Start",
        role: "entry",
        description: "",
        timeoutMs: null,
        inputSchema: {
          properties: {
            topic: { type: "string" },
            count: { type: "number" },
          },
          required: ["topic"],
        },
        capabilities: [],
      },
      {
        id: "step-1",
        kind: "step",
        label: "Process",
        role: "step",
        description: "",
        timeoutMs: null,
        inputSchema: null,
        capabilities: [],
      },
    ],
    edges: [{ from: "entry-node", to: "step-1", kind: "sequential", label: "" }],
    groups: [],
    warnings: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildSkeleton
// ---------------------------------------------------------------------------

describe("buildSkeleton", () => {
  it("returns '{}' when graph is null", () => {
    expect(buildSkeleton(null)).toBe("{}");
  });

  it("returns '{}' when the entry node has no input fields", () => {
    const graph = makeGraph();
    // Replace the entry node with one that has no inputSchema.
    graph.nodes[0].inputSchema = null;
    expect(buildSkeleton(graph)).toBe("{}");
  });

  it("returns '{}' when inputSchema has no properties", () => {
    const graph = makeGraph();
    graph.nodes[0].inputSchema = { properties: {}, required: [] };
    // parseInputSchema returns null for empty properties; buildSkeleton handles null.
    // But since we're setting inputSchema directly, an empty properties object
    // produces no fields, so the skeleton should be '{}'.
    expect(buildSkeleton(graph)).toBe("{}");
  });

  it("builds a skeleton from the entry node's input fields", () => {
    const graph = makeGraph();
    const result = buildSkeleton(graph);
    const parsed = JSON.parse(result);
    // Required fields come first (topic), then optional (count).
    expect(Object.keys(parsed)).toEqual(["topic", "count"]);
    expect(parsed.topic).toBe("<string>");
    expect(parsed.count).toBe("<number>");
  });

  it("falls back to kind=entry node when entry id does not match any node id", () => {
    const graph = makeGraph({ entry: "nonexistent-id" });
    // The first node has kind="entry" so it should still be found.
    const result = buildSkeleton(graph);
    const parsed = JSON.parse(result);
    expect(Object.keys(parsed)).toContain("topic");
  });

  it("returns '{}' when no entry node can be found", () => {
    const graph = makeGraph({ entry: "nonexistent-id" });
    // Remove the entry-kind node so neither lookup finds anything.
    graph.nodes[0].kind = "step";
    expect(buildSkeleton(graph)).toBe("{}");
  });

  it("formats the skeleton as pretty-printed JSON", () => {
    const graph = makeGraph();
    const result = buildSkeleton(graph);
    // Should be indented (pretty-printed), not compact.
    expect(result).toContain("\n");
    expect(result).toContain("  ");
  });
});

// ---------------------------------------------------------------------------
// buildFieldHint
// ---------------------------------------------------------------------------

describe("buildFieldHint", () => {
  it("returns empty string when graph is null", () => {
    expect(buildFieldHint(null)).toBe("");
  });

  it("returns empty string when entry node has no input fields", () => {
    const graph = makeGraph();
    graph.nodes[0].inputSchema = null;
    expect(buildFieldHint(graph)).toBe("");
  });

  it("builds a hint string listing required and optional fields", () => {
    const graph = makeGraph();
    const hint = buildFieldHint(graph);
    // topic is required (no ?), count is optional (has ?)
    expect(hint).toContain("topic: string");
    expect(hint).toContain("count: number?");
    expect(hint).toMatch(/^Entry step expects:/);
  });

  it("marks required fields without ? and optional fields with ?", () => {
    const graph = makeGraph();
    const hint = buildFieldHint(graph);
    // topic is required: no trailing ?
    expect(hint).not.toContain("topic: string?");
    // count is optional: has trailing ?
    expect(hint).toContain("count: number?");
  });
});

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

describe("loadLastInput / saveLastInput", () => {
  const testPath = "/Users/demo/my-workflow";

  beforeEach(() => {
    setupLocalStorageMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loadLastInput returns null when no value is stored", () => {
    expect(loadLastInput(testPath)).toBeNull();
  });

  it("saveLastInput + loadLastInput round-trips the value", () => {
    const value = '{"topic":"birds"}';
    saveLastInput(testPath, value);
    expect(loadLastInput(testPath)).toBe(value);
  });

  it("saves per-path: different workflow paths store independently", () => {
    saveLastInput("/path/a", '{"x":1}');
    saveLastInput("/path/b", '{"y":2}');
    expect(loadLastInput("/path/a")).toBe('{"x":1}');
    expect(loadLastInput("/path/b")).toBe('{"y":2}');
  });

  it("overwriting updates the stored value", () => {
    saveLastInput(testPath, '{"first":true}');
    saveLastInput(testPath, '{"second":true}');
    expect(loadLastInput(testPath)).toBe('{"second":true}');
  });

  it("handles localStorage errors gracefully (save)", () => {
    // Override setItem on the stubbed localStorage to throw.
    const mock = makeLocalStorageMock();
    mock.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    vi.stubGlobal("localStorage", mock);
    // Should not throw.
    expect(() => saveLastInput(testPath, '{"x":1}')).not.toThrow();
  });

  it("handles localStorage errors gracefully (load)", () => {
    const mock = makeLocalStorageMock();
    mock.getItem = () => {
      throw new Error("SecurityError");
    };
    vi.stubGlobal("localStorage", mock);
    expect(loadLastInput(testPath)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeInitialValue — prefill priority
// ---------------------------------------------------------------------------

describe("computeInitialValue — prefill priority", () => {
  const testPath = "/Users/demo/my-workflow";

  beforeEach(() => {
    setupLocalStorageMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("priority 3: returns '{}' when no last-used and no graph", () => {
    expect(computeInitialValue(testPath, null)).toBe("{}");
  });

  it("priority 2: returns skeleton when no last-used but graph is available", () => {
    const graph = makeGraph();
    const result = computeInitialValue(testPath, graph);
    const parsed = JSON.parse(result);
    expect(Object.keys(parsed)).toContain("topic");
  });

  it("priority 1: last-used beats skeleton (returns stored value regardless of graph)", () => {
    const stored = '{"topic":"cats"}';
    saveLastInput(testPath, stored);
    const graph = makeGraph();
    // Even though graph provides a skeleton, stored takes priority.
    expect(computeInitialValue(testPath, graph)).toBe(stored);
  });

  it("priority 1: last-used beats {} (returns stored value when no graph)", () => {
    const stored = '{"myKey":"value"}';
    saveLastInput(testPath, stored);
    expect(computeInitialValue(testPath, null)).toBe(stored);
  });

  it("priority is path-scoped: last-used for one path does not affect another", () => {
    saveLastInput("/path/a", '{"a":1}');
    // /path/b has no last-used; with no graph it should return '{}'.
    expect(computeInitialValue("/path/b", null)).toBe("{}");
  });
});
