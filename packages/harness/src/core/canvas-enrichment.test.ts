import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CanvasGraph } from "./canvas-graph.js";
import {
  ENRICHMENT_LIMITS,
  parseCanvasEnrichment,
  readEnrichmentCacheFile,
  removeEnrichmentCacheFile,
  writeEnrichmentCacheFile,
  type EnrichmentCacheEntry,
} from "./canvas-enrichment.js";

const FULL_ENRICHMENT = {
  summary: "Triage incoming orders and route them to auto-resolution or a human",
  nodeDetails: {
    intake: { sublabel: "receives the order event", description: "Entry point: normalizes the incoming order payload." },
    route: { sublabel: "priority-based split" },
  },
  edgeLabels: { "route->auto_resolve": "low priority", "route->escalate": "needs a human" },
  notes: ["Orders above $10k always escalate", "Retries are handled by the runtime, not the steps"],
  layoutHints: {
    groups: [{ label: "decision core", nodeIds: ["classify", "route"] }],
    laneOrder: { "3": ["escalate", "auto_resolve"] },
  },
  crossWorkflow: "Escalations land in the support-inbox workflow via launch()",
};

describe("parseCanvasEnrichment", () => {
  it("round-trips a fully populated enrichment unchanged", () => {
    expect(parseCanvasEnrichment(FULL_ENRICHMENT)).toEqual(FULL_ENRICHMENT);
  });

  it("accepts a minimal enrichment — every field is optional", () => {
    expect(parseCanvasEnrichment({})).toEqual({});
    expect(parseCanvasEnrichment({ summary: "just a summary" })).toEqual({ summary: "just a summary" });
  });

  it("strips unknown keys at every level instead of failing on them", () => {
    const parsed = parseCanvasEnrichment({
      summary: "ok",
      html: "<script>alert(1)</script>", // top-level junk
      nodeDetails: { intake: { sublabel: "fine", css: "position:fixed" } }, // nested junk
      layoutHints: { groups: [{ label: "g", nodeIds: ["a"], color: "red" }], zIndex: 4 },
    });
    expect(parsed).toEqual({
      summary: "ok",
      nodeDetails: { intake: { sublabel: "fine" } },
      layoutHints: { groups: [{ label: "g", nodeIds: ["a"] }] },
    });
  });

  it.each([
    ["summary", { summary: "x".repeat(ENRICHMENT_LIMITS.summary + 1) }],
    ["sublabel", { nodeDetails: { intake: { sublabel: "x".repeat(ENRICHMENT_LIMITS.sublabel + 1) } } }],
    ["description", { nodeDetails: { intake: { description: "x".repeat(ENRICHMENT_LIMITS.description + 1) } } }],
    ["edge label", { edgeLabels: { "a->b": "x".repeat(ENRICHMENT_LIMITS.edgeLabel + 1) } }],
    ["note", { notes: ["x".repeat(ENRICHMENT_LIMITS.note + 1)] }],
    ["group label", { layoutHints: { groups: [{ label: "x".repeat(ENRICHMENT_LIMITS.groupLabel + 1), nodeIds: ["a"] }] } }],
    ["crossWorkflow", { crossWorkflow: "x".repeat(ENRICHMENT_LIMITS.crossWorkflow + 1) }],
  ])("rejects the WHOLE enrichment when one %s exceeds its hard cap — no partial salvage", (_field, value) => {
    expect(parseCanvasEnrichment(value)).toBeNull();
  });

  it("rejects more notes than the cap allows", () => {
    expect(parseCanvasEnrichment({ notes: ["a", "b", "c", "d"] })).toBeNull();
    expect(parseCanvasEnrichment({ notes: ["a", "b", "c"] })).toEqual({ notes: ["a", "b", "c"] });
  });

  it("rejects structurally wrong shapes (arrays, strings, wrong nesting)", () => {
    expect(parseCanvasEnrichment("just a string")).toBeNull();
    expect(parseCanvasEnrichment([FULL_ENRICHMENT])).toBeNull();
    expect(parseCanvasEnrichment({ nodeDetails: { intake: "not an object" } })).toBeNull();
    expect(parseCanvasEnrichment({ layoutHints: { groups: [{ label: "g", nodeIds: [] }] } })).toBeNull();
  });
});

describe("enrichment cache file IO", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });
  async function tmpFile(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-enrichment-test-"));
    tmpDirs.push(dir);
    return path.join(dir, "cache", "wf.json"); // nested — write must mkdir
  }

  const GRAPH: CanvasGraph = {
    manifestName: "order-triage",
    entry: "intake",
    warnings: [],
    nodes: [{ id: "intake", kind: "entry", label: "intake" }],
    edges: [],
  };
  const ENTRY: EnrichmentCacheEntry = {
    graph: GRAPH,
    enrichment: { summary: "hello" },
    sourceFingerprint: "3:1700000000000",
    enrichedAt: "2026-01-01T00:00:00.000Z",
  };

  it("round-trips an entry through write + read, creating parent dirs", async () => {
    const file = await tmpFile();
    await writeEnrichmentCacheFile(file, ENTRY);
    await expect(readEnrichmentCacheFile(file)).resolves.toEqual(ENTRY);
  });

  it("returns null for a missing file", async () => {
    await expect(readEnrichmentCacheFile((await tmpFile()) + ".nope")).resolves.toBeNull();
  });

  it("returns null for corrupt JSON and for a schema-invalid enrichment inside the envelope", async () => {
    const file = await tmpFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{not json", "utf8");
    await expect(readEnrichmentCacheFile(file)).resolves.toBeNull();

    // A hand-edited cache can't smuggle an unbounded string into a render:
    // the enrichment inside the envelope is re-validated on every read.
    const oversize = { ...ENTRY, enrichment: { summary: "x".repeat(999) } };
    await fs.writeFile(file, JSON.stringify(oversize), "utf8");
    await expect(readEnrichmentCacheFile(file)).resolves.toBeNull();
  });

  it("removeEnrichmentCacheFile deletes the file and tolerates its absence", async () => {
    const file = await tmpFile();
    await writeEnrichmentCacheFile(file, ENTRY);
    await removeEnrichmentCacheFile(file);
    await expect(readEnrichmentCacheFile(file)).resolves.toBeNull();
    await expect(removeEnrichmentCacheFile(file)).resolves.toBeUndefined(); // already gone
  });
});
