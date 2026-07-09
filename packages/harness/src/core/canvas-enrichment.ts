/**
 * The AI enrichment contract: everything the enrichment task is allowed to
 * add to a deterministic canvas render, as a zod schema. The AI never writes
 * HTML — it returns one JSON object of BOUNDED plain strings (every limit
 * below is a hard cap, not advice) and the renderer decides where they go.
 * Unknown keys are stripped; any parse failure means the whole enrichment is
 * discarded and the base render stands — a malformed answer can degrade
 * nothing but itself.
 *
 * Layout hints are the one structural concession: named groups (rendered as
 * subtle background bands) and per-layer ordering. The renderer applies a
 * hint only when every node id it references actually exists in the graph
 * (see canvas-svg.ts) — ids are validated at render time, not here, because
 * an enrichment can outlive the graph it was written against (the "stale"
 * cache state).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { CanvasGraph } from "./canvas-graph.js";

export const ENRICHMENT_LIMITS = {
  summary: 160,
  sublabel: 48,
  description: 120,
  edgeLabel: 32,
  noteCount: 3,
  note: 140,
  groupLabel: 48,
  crossWorkflow: 160,
} as const;

const bounded = (max: number): z.ZodString => z.string().max(max);

export const canvasEnrichmentSchema = z
  .object({
    /** One-liner under the panel header. */
    summary: bounded(ENRICHMENT_LIMITS.summary).optional(),
    /** Per-node annotations, keyed by node id. */
    nodeDetails: z
      .record(
        z
          .object({
            /** Second text line inside the node box. */
            sublabel: bounded(ENRICHMENT_LIMITS.sublabel).optional(),
            /** Hover tooltip (SVG <title>) — room for a full sentence. */
            description: bounded(ENRICHMENT_LIMITS.description).optional(),
          })
          .strip(),
      )
      .optional(),
    /** Edge annotations (intent/condition names), keyed `"<from>-><to>"`. */
    edgeLabels: z.record(bounded(ENRICHMENT_LIMITS.edgeLabel)).optional(),
    /** Footer facts worth knowing that don't fit the diagram itself. */
    notes: z.array(bounded(ENRICHMENT_LIMITS.note)).max(ENRICHMENT_LIMITS.noteCount).optional(),
    layoutHints: z
      .object({
        /** Named clusters rendered as background bands behind member nodes. */
        groups: z
          .array(
            z
              .object({
                label: bounded(ENRICHMENT_LIMITS.groupLabel),
                nodeIds: z.array(z.string()).min(1),
              })
              .strip(),
          )
          .optional(),
        /** Preferred left-to-right node order per layout layer, keyed by the
         *  layer index as a string. Reorders WITHIN the computed layer only —
         *  it can never move a node between layers. */
        laneOrder: z.record(z.array(z.string()).min(1)).optional(),
      })
      .strip()
      .optional(),
    /** How this workflow ties into the workspace's other workflows. */
    crossWorkflow: bounded(ENRICHMENT_LIMITS.crossWorkflow).optional(),
  })
  .strip();

export type CanvasEnrichment = z.infer<typeof canvasEnrichmentSchema>;
export type CanvasLayoutHints = NonNullable<CanvasEnrichment["layoutHints"]>;

/**
 * Validates a candidate enrichment object. Returns null on ANY schema
 * violation (oversize string, wrong shape, too many notes) — partial
 * salvage is deliberately not attempted, so the contract stays a hard line
 * the prompt can state truthfully: "invalid output is thrown away whole."
 */
export function parseCanvasEnrichment(value: unknown): CanvasEnrichment | null {
  const parsed = canvasEnrichmentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function clampString(value: unknown, max: number): unknown {
  if (typeof value !== "string" || value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Removes null/undefined-valued properties (models write `"field": null`
 *  to mean "omitted"; the schema means it as `undefined`). Shallow — called
 *  per level below where object shapes are known. */
function dropNulls(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v != null));
}

/**
 * Deterministic repair of the two ways an otherwise-good answer most often
 * misses the contract, applied BEFORE strict validation:
 * - `null` where the schema means "omit the field"
 * - strings a few words over their cap (measured live: sonnet writes
 *   excellent content but doesn't count characters — a single 160-char note
 *   against the 140 cap discarded 3 of 4 real enrichments whole), truncated
 *   to the cap with an ellipsis; extra notes beyond the count cap dropped
 *
 * The bound the caps exist for — the AI can never blow up the layout with
 * unbounded text — is still enforced, just deterministically here instead
 * of by rejection. Everything else (wrong shapes, wrong types, unknown
 * structure) still fails `parseCanvasEnrichment` and discards the
 * enrichment whole.
 */
export function normalizeCanvasEnrichmentCandidate(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const L = ENRICHMENT_LIMITS;
  const out: Record<string, unknown> = { ...value };

  out.summary = clampString(out.summary, L.summary);
  out.crossWorkflow = clampString(out.crossWorkflow, L.crossWorkflow);

  if (isRecord(out.nodeDetails)) {
    out.nodeDetails = Object.fromEntries(
      Object.entries(out.nodeDetails).map(([id, details]) => {
        if (!isRecord(details)) return [id, details];
        return [
          id,
          dropNulls({
            ...details,
            sublabel: clampString(details.sublabel, L.sublabel),
            description: clampString(details.description, L.description),
          }),
        ];
      }),
    );
  }

  if (isRecord(out.edgeLabels)) {
    out.edgeLabels = Object.fromEntries(
      Object.entries(out.edgeLabels).map(([key, label]) => [key, clampString(label, L.edgeLabel)]),
    );
  }

  if (Array.isArray(out.notes)) {
    out.notes = out.notes.slice(0, L.noteCount).map((note) => clampString(note, L.note));
  }

  if (isRecord(out.layoutHints)) {
    const hints = dropNulls({ ...out.layoutHints });
    if (Array.isArray(hints.groups)) {
      hints.groups = hints.groups.map((group) =>
        isRecord(group) ? dropNulls({ ...group, label: clampString(group.label, L.groupLabel) }) : group,
      );
    }
    out.layoutHints = hints;
  }

  return dropNulls(out);
}

// ---------------------------------------------------------------------------
// Per-workflow enrichment cache file (CANVAS_CACHE_DIR/<slug>.json)
// ---------------------------------------------------------------------------

/**
 * What one cache file holds. `sourceFingerprint` is canvas-cache.ts's cheap
 * source fingerprint at the moment the enrichment task was SPAWNED — when it
 * no longer matches the workflow's current sources, the base diagram
 * re-renders immediately from fresh extraction while this enrichment stays
 * displayed with a "stale" chip until a re-run replaces it.
 */
export interface EnrichmentCacheEntry {
  /** The graph the enrichment was generated against (diagnostic context —
   *  renders always use the freshly extracted graph, never this copy). */
  graph: CanvasGraph;
  enrichment: CanvasEnrichment;
  sourceFingerprint: string;
  enrichedAt: string;
}

/** Envelope validation is deliberately shallow for `graph` (it's our own
 *  writer's serialization, not AI output) and strict for `enrichment` (it IS
 *  AI output — re-validated on every read, so a hand-edited or corrupted
 *  cache file can never smuggle unbounded strings into a render). */
const cacheEntrySchema = z.object({
  graph: z.object({
    manifestName: z.string(),
    entry: z.string(),
    nodes: z.array(z.record(z.unknown())),
    edges: z.array(z.record(z.unknown())),
    warnings: z.array(z.string()),
  }),
  enrichment: canvasEnrichmentSchema,
  sourceFingerprint: z.string(),
  enrichedAt: z.string(),
});

/** Reads + validates one enrichment cache file. Null for missing, unparsable
 *  or schema-invalid content — a bad cache degrades to "no enrichment". */
export async function readEnrichmentCacheFile(filePath: string): Promise<EnrichmentCacheEntry | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = cacheEntrySchema.safeParse(JSON.parse(raw));
    // The shallow node/edge validation above means this cast, not a full
    // structural proof — see the schema's own comment for why that's enough.
    return parsed.success ? (parsed.data as unknown as EnrichmentCacheEntry) : null;
  } catch {
    return null;
  }
}

export async function writeEnrichmentCacheFile(filePath: string, entry: EnrichmentCacheEntry): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(entry, null, 2), "utf8");
}

/** Deletes one enrichment cache file (the visualize macro's force refresh).
 *  Missing file is fine — the goal state is "no cache". */
export async function removeEnrichmentCacheFile(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}
