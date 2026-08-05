import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_PROJECT_MARKER } from "../shared/types.js";
import {
  readAgentProjectMarker,
  readAgentProjectMarkerSync,
} from "./agent-project-discovery.js";

describe("agent project marker reads", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-agent-marker-"));
  });

  afterEach(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });

  it("reads the fixed marker directly beneath the selected directory", async () => {
    // Includes the provenance fields to pin the parser's wholesale cast:
    // fields it doesn't know by name still round-trip.
    const marker = {
      definitionId: 42,
      name: "approval-agent",
      templateId: "tmpl-1",
      forkId: "fork-1",
      starterId: "coding-pause",
    };
    await fs.writeFile(
      path.join(root, AGENT_PROJECT_MARKER),
      JSON.stringify(marker),
    );

    expect(await readAgentProjectMarker(root)).toEqual(marker);
    expect(readAgentProjectMarkerSync(root)).toEqual(marker);
  });

  it("rejects a marker symlink instead of following it to another file", async () => {
    const outside = path.join(
      path.dirname(root),
      `${path.basename(root)}-outside.json`,
    );
    await fs.writeFile(outside, JSON.stringify({ definitionId: 999 }));
    await fs.symlink(outside, path.join(root, AGENT_PROJECT_MARKER));

    try {
      expect(await readAgentProjectMarker(root)).toBeNull();
      expect(readAgentProjectMarkerSync(root)).toBeNull();
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});
