/**
 * The canvas enrichment contract: the optional annotation layer merged on top
 * of a deterministic canvas render — a summary line, per-node sublabels/hover
 * descriptions, edge labels, footer notes, layout hints, and a cross-workflow
 * tie. Every value is a BOUNDED plain string (the limits below are hard caps
 * that keep the SVG layout from breaking); the renderer (core/canvas-svg.ts,
 * core/canvas-body.ts) decides where each field goes.
 *
 * The enrichment is produced DETERMINISTICALLY, in-process, from the extracted
 * graph — see core/canvas-derive.ts. There is no LLM, no user token, no file
 * write, and no cache: it is recomputed from the current sources on every
 * render, so it can never go stale. This module is now just the shared shape +
 * limits both the producer (canvas-derive.ts) and the consumer (canvas-svg.ts,
 * canvas-body.ts) agree on.
 *
 * Layout hints are the one structural field: named groups (rendered as subtle
 * background bands) and per-layer ordering. The renderer applies a hint only
 * when every node id it references actually exists in the graph (see
 * canvas-svg.ts) — ids are validated at render time.
 */

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

/** Per-node annotations, keyed by node id. */
export interface CanvasNodeDetail {
  /** Second text line inside the node box. */
  sublabel?: string;
  /** Hover tooltip (SVG <title>) — room for a full sentence. */
  description?: string;
}

/**
 * The one structural hint set: named clusters rendered as background bands
 * behind their member nodes, and a preferred left-to-right node order per
 * layout layer (keyed by the layer index as a string). `laneOrder` reorders
 * WITHIN a computed layer only — it can never move a node between layers.
 */
export interface CanvasLayoutHints {
  groups?: Array<{ label: string; nodeIds: string[] }>;
  laneOrder?: Record<string, string[]>;
}

/**
 * Everything the enrichment layer can add to a deterministic render. Every
 * field is optional — the base structure render stands on its own without any
 * of it, so a workflow with nothing worth annotating simply renders clean.
 */
export interface CanvasEnrichment {
  /** One-liner under the panel header. */
  summary?: string;
  /** Per-node annotations, keyed by node id. */
  nodeDetails?: Record<string, CanvasNodeDetail>;
  /** Edge annotations (intent/condition names), keyed `"<from>-><to>"`. */
  edgeLabels?: Record<string, string>;
  /** Footer facts worth knowing that don't fit the diagram itself. */
  notes?: string[];
  layoutHints?: CanvasLayoutHints;
  /** How this workflow ties into the workspace's other workflows. */
  crossWorkflow?: string;
}
