import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CANVAS_INDEX } from "../shared/types.js";
import { CANVAS_TEMPLATE_FILE, TEMPLATE_HTML, ensureCanvasTemplate, renderCanvasDocument } from "./canvas-template.js";

describe("renderCanvasDocument", () => {
  it("produces a single self-contained document: no external stylesheets, scripts, or fetches", () => {
    const html = renderCanvasDocument("<p>hi</p>");
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);
    expect(html).not.toMatch(/<script[^>]+src=["']https?:/i);
    // The only <script> content is the theme switch — it must never itself
    // issue a network fetch.
    expect(html).not.toMatch(/\bfetch\s*\(/);
  });

  it("embeds the given body content verbatim inside #canvas-root", () => {
    const html = renderCanvasDocument("<p>marker-content-xyz</p>");
    expect(html).toContain('<div id="canvas-root">');
    expect(html).toContain("marker-content-xyz");
  });

  it("bakes in both light and dark palettes, keyed off data-canvas-theme / prefers-color-scheme", () => {
    const html = renderCanvasDocument("");
    expect(html).toContain('[data-canvas-theme="dark"]');
    expect(html).toContain("prefers-color-scheme: dark");
    // Exact dark-theme accent hex from web/src/styles.css — same palette the
    // rest of the app renders in dark mode.
    expect(html).toContain("#6be195");
    // Exact light-theme accent hex.
    expect(html).toContain("#05a9bc");
  });

  it("reads the theme from a ?theme= query param client-side, with no server-side dependency", () => {
    const html = renderCanvasDocument("");
    expect(html).toMatch(/URLSearchParams\(location\.search\)/);
    expect(html).toMatch(/params\.get\("theme"\)/);
  });

  it("ships the SVG defs (glow filter, arrow markers) every node/edge pattern references", () => {
    const html = renderCanvasDocument("");
    expect(html).toContain('id="canvas-glow"');
    expect(html).toContain('id="canvas-arrow"');
    expect(html).toContain('id="canvas-arrow-success"');
    expect(html).toContain('id="canvas-arrow-warn"');
  });

  it("has no JSON data block and no data-parsing renderer script — markup only", () => {
    const html = renderCanvasDocument("");
    expect(html).not.toMatch(/canvas-data/);
    expect(html).not.toMatch(/JSON\.parse/);
  });
});

describe("TEMPLATE_HTML", () => {
  it("is a complete, self-contained document produced by renderCanvasDocument", () => {
    expect(TEMPLATE_HTML).toContain("<!DOCTYPE html>");
    expect(TEMPLATE_HTML).toContain('<div id="canvas-root">');
  });

  it("carries a friendly empty-state note, not a blank panel", () => {
    expect(TEMPLATE_HTML).toMatch(/nothing visualized yet/i);
  });

  it("documents one example of every node kind and edge kind inside an inert <template>", () => {
    expect(TEMPLATE_HTML).toContain('<template id="canvas-patterns">');
    for (const nodeKind of ["node--entry", "node--step", "node--pause", "node--terminal-success", "node--terminal-warn"]) {
      expect(TEMPLATE_HTML).toContain(nodeKind);
    }
    // sequential (base .canvas-edge), branching (--success/--warn), cross-workflow (--cross)
    for (const edgeClass of ["canvas-edge--success", "canvas-edge--warn", "canvas-edge--cross"]) {
      expect(TEMPLATE_HTML).toContain(edgeClass);
    }
  });

  it("documents a legend entry and an interconnection row pattern", () => {
    expect(TEMPLATE_HTML).toContain("canvas-legend-item");
    expect(TEMPLATE_HTML).toContain("canvas-interconnection-row");
  });

  it("instructs the agent not to touch the CSS or structural classes", () => {
    expect(TEMPLATE_HTML).toMatch(/keep the.*style.*untouched/is);
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

  async function readIndex(): Promise<string> {
    return fs.readFile(path.join(cwd, CANVAS_INDEX), "utf8");
  }

  async function readTemplate(): Promise<string> {
    return fs.readFile(path.join(cwd, CANVAS_TEMPLATE_FILE), "utf8");
  }

  it("writes both _template.html and index.html with the same empty-state content when nothing exists yet", async () => {
    await ensureCanvasTemplate(cwd);
    expect(await readIndex()).toBe(TEMPLATE_HTML);
    expect(await readTemplate()).toBe(TEMPLATE_HTML);
  });

  it("never clobbers an index.html that's already there — backfill only", async () => {
    await fs.mkdir(path.dirname(path.join(cwd, CANVAS_INDEX)), { recursive: true });
    await fs.writeFile(path.join(cwd, CANVAS_INDEX), "already customized by an earlier session", "utf8");

    await ensureCanvasTemplate(cwd);

    expect(await readIndex()).toBe("already customized by an earlier session");
    // _template.html still gets backfilled independently — an agent that
    // customized index.html before the template existed still needs a
    // pristine clone source for future re-visualizes.
    expect(await readTemplate()).toBe(TEMPLATE_HTML);
  });

  it("never clobbers _template.html either, independent of index.html's state", async () => {
    await fs.mkdir(path.dirname(path.join(cwd, CANVAS_TEMPLATE_FILE)), { recursive: true });
    await fs.writeFile(path.join(cwd, CANVAS_TEMPLATE_FILE), "a pristine copy from a previous session", "utf8");

    await ensureCanvasTemplate(cwd);

    expect(await readTemplate()).toBe("a pristine copy from a previous session");
    expect(await readIndex()).toBe(TEMPLATE_HTML);
  });

  it("is idempotent: calling it twice on an empty cwd doesn't error or duplicate anything", async () => {
    await ensureCanvasTemplate(cwd);
    await ensureCanvasTemplate(cwd);
    expect(await readIndex()).toBe(TEMPLATE_HTML);
    expect(await readTemplate()).toBe(TEMPLATE_HTML);
  });

  it("does not throw when the cwd is unwritable (logs and returns)", async () => {
    const blockedFile = path.join(cwd, "blocked");
    await fs.writeFile(blockedFile, "x");
    await expect(ensureCanvasTemplate(blockedFile)).resolves.toBeUndefined();
  });
});
