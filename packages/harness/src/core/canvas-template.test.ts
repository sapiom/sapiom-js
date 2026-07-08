import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CANVAS_INDEX } from "../shared/types.js";
import { EMPTY_CANVAS_DATA, ensureCanvasTemplate, renderCanvasHtml, type CanvasData } from "./canvas-template.js";

const SAMPLE: CanvasData = {
  version: 1,
  graphs: [
    {
      id: "wf",
      title: "example",
      nodes: [
        { id: "a", kind: "entry", label: "a" },
        { id: "b", kind: "terminal-success", label: "b" },
      ],
      edges: [{ from: "a", to: "b", kind: "sequential" }],
    },
  ],
};

describe("renderCanvasHtml", () => {
  it("produces a single self-contained document: no external stylesheets, scripts, or fetches", () => {
    const html = renderCanvasHtml(SAMPLE);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);
    expect(html).not.toMatch(/<script[^>]+src=["']https?:/i);
    // The renderer's own inline script is the only <script> content — it must
    // never itself issue a network fetch.
    expect(html).not.toMatch(/\bfetch\s*\(/);
  });

  it("embeds the data verbatim, pretty-printed, inside the canvas-data script tag", () => {
    const html = renderCanvasHtml(SAMPLE);
    expect(html).toContain('<script type="application/json" id="canvas-data">');
    expect(html).toContain(JSON.stringify(SAMPLE, null, 2));
  });

  it("documents the data schema tersely as a comment, in-context with the data block", () => {
    const html = renderCanvasHtml(SAMPLE);
    expect(html).toMatch(/canvas-data schema/i);
    // Schema comment must precede the data it documents (an LLM reading
    // top-to-bottom should see the schema before the JSON it's about to edit).
    expect(html.indexOf("canvas-data schema")).toBeLessThan(html.indexOf('id="canvas-data"'));
  });

  it("bakes in both light and dark palettes, keyed off data-canvas-theme / prefers-color-scheme", () => {
    const html = renderCanvasHtml(SAMPLE);
    expect(html).toContain('[data-canvas-theme="dark"]');
    expect(html).toContain("prefers-color-scheme: dark");
    // Exact dark-theme accent hex from web/src/styles.css — same palette the
    // rest of the app renders in dark mode.
    expect(html).toContain("#6be195");
    // Exact light-theme accent hex.
    expect(html).toContain("#05a9bc");
  });

  it("reads the theme from a ?theme= query param client-side, with no server-side dependency", () => {
    const html = renderCanvasHtml(SAMPLE);
    expect(html).toMatch(/URLSearchParams\(location\.search\)/);
    expect(html).toMatch(/params\.get\("theme"\)/);
  });
});

describe("EMPTY_CANVAS_DATA", () => {
  it("has no graphs and a friendly note, and still renders without graphs-array assumptions blowing up", () => {
    expect(EMPTY_CANVAS_DATA.graphs).toEqual([]);
    expect(EMPTY_CANVAS_DATA.note).toBeTruthy();
    expect(() => renderCanvasHtml(EMPTY_CANVAS_DATA)).not.toThrow();
  });
});

describe("ensureCanvasTemplate", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-canvas-template-test-"));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  async function readCanvas(): Promise<string> {
    return fs.readFile(path.join(cwd, CANVAS_INDEX), "utf8");
  }

  it("writes the empty-state template when nothing exists yet", async () => {
    await ensureCanvasTemplate(cwd);
    const html = await readCanvas();
    expect(html).toBe(renderCanvasHtml(EMPTY_CANVAS_DATA));
  });

  it("never clobbers a file that's already there — backfill only", async () => {
    await fs.mkdir(path.dirname(path.join(cwd, CANVAS_INDEX)), { recursive: true });
    await fs.writeFile(path.join(cwd, CANVAS_INDEX), "already customized by an earlier session", "utf8");

    await ensureCanvasTemplate(cwd);

    expect(await readCanvas()).toBe("already customized by an earlier session");
  });

  it("is idempotent: calling it twice on an empty cwd doesn't error or duplicate anything", async () => {
    await ensureCanvasTemplate(cwd);
    await ensureCanvasTemplate(cwd);
    expect(await readCanvas()).toBe(renderCanvasHtml(EMPTY_CANVAS_DATA));
  });

  it("does not throw when the cwd is unwritable (logs and returns)", async () => {
    const blockedFile = path.join(cwd, "blocked");
    await fs.writeFile(blockedFile, "x");
    await expect(ensureCanvasTemplate(blockedFile)).resolves.toBeUndefined();
  });
});
