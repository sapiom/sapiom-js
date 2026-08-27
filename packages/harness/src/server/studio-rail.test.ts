/**
 * `.sapiom/studio-rail.json` on disk, and the launch edges the Group axis seeds
 * from (SAP-2929).
 *
 * The thing worth testing here is what the server does NOT do. It never decodes
 * or re-encodes the blob, so the null/empty distinction the model depends on
 * cannot be collapsed on the way to disk, and an un-materialized arrangement
 * reaches the file system as a DELETE rather than as `groups: []`.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import express from "express";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  createStudioRailRouter,
  detectLaunchEdges,
  MAX_STUDIO_RAIL_BYTES,
  readStudioRailFile,
  removeStudioRailFile,
  studioRailPath,
  writeStudioRailFile,
} from "./studio-rail.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "studio-rail-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const railFile = (root: string): string => path.join(root, ".sapiom", "studio-rail.json");

/** A live express app over the router, so the routes are exercised as routes. */
async function serve(
  roots: string[],
  workflows: Array<{ name: string; path: string }> = [],
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(createStudioRailRouter({ listKnownRoots: () => roots, listWorkflows: () => workflows }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("studioRailPath", () => {
  it("lands the file under the root's own .sapiom directory", () => {
    expect(studioRailPath("/Users/dev/polsia")).toBe(
      path.join("/Users/dev/polsia", ".sapiom", "studio-rail.json"),
    );
  });
});

describe("read / write / remove", () => {
  it("reads an absent file as nothing stored", async () => {
    expect(await readStudioRailFile(tmp)).toBeNull();
  });

  it("round-trips the blob VERBATIM, `groups: null` included", async () => {
    // The whole point of a text wire format: the server is not a second
    // serializer, so it cannot turn `null` into `[]` on the way through.
    const raw = '{\n  "version": 1,\n  "groups": null,\n  "renames": {}\n}\n';
    await writeStudioRailFile(tmp, raw);
    expect(await readStudioRailFile(tmp)).toBe(raw);
  });

  it("creates .sapiom when it is not there yet", async () => {
    await writeStudioRailFile(tmp, "{}");
    await expect(fs.stat(path.join(tmp, ".sapiom"))).resolves.toBeTruthy();
  });

  it("removes the file, and treats a missing one as already removed", async () => {
    await writeStudioRailFile(tmp, "{}");
    await removeStudioRailFile(tmp);
    expect(await readStudioRailFile(tmp)).toBeNull();
    // Idempotent: "there is no stored arrangement" is the requested end state.
    await expect(removeStudioRailFile(tmp)).resolves.toBeUndefined();
  });

  it("reads an oversized file as nothing stored rather than loading it", async () => {
    await fs.mkdir(path.join(tmp, ".sapiom"), { recursive: true });
    await fs.writeFile(railFile(tmp), "x".repeat(MAX_STUDIO_RAIL_BYTES + 1), "utf8");
    expect(await readStudioRailFile(tmp)).toBeNull();
  });

  it("reads a directory in the file's place as nothing stored", async () => {
    await fs.mkdir(railFile(tmp), { recursive: true });
    expect(await readStudioRailFile(tmp)).toBeNull();
  });
});

describe("the routes", () => {
  it("GETs null for a known root with no file, and 400s for an unknown one", async () => {
    const { url, close } = await serve([tmp]);
    try {
      const ok = await fetch(`${url}/api/studio-rail?root=${encodeURIComponent(tmp)}`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ root: path.resolve(tmp), raw: null });

      // Resolution happens BEFORE any disk access, so this is not a file reader
      // that can be aimed anywhere the studio has not been pointed.
      const nope = await fetch(`${url}/api/studio-rail?root=${encodeURIComponent(os.tmpdir())}`);
      expect(nope.status).toBe(400);
      expect(await fetch(`${url}/api/studio-rail`)).toHaveProperty("status", 400);
    } finally {
      await close();
    }
  });

  it("accepts a trailing separator as the same root", async () => {
    const { url, close } = await serve([tmp]);
    try {
      const res = await fetch(`${url}/api/studio-rail?root=${encodeURIComponent(`${tmp}/`)}`);
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });

  it("refuses a relative path and one carrying a `..` segment", async () => {
    const { url, close } = await serve([tmp]);
    try {
      for (const root of ["relative/path", `${tmp}/../${path.basename(tmp)}`]) {
        const res = await fetch(`${url}/api/studio-rail?root=${encodeURIComponent(root)}`);
        expect(res.status, root).toBe(400);
      }
    } finally {
      await close();
    }
  });

  it("PUTs the raw text and GETs it back byte for byte", async () => {
    const { url, close } = await serve([tmp]);
    const raw = '{\n  "version": 1,\n  "groups": [],\n  "renames": {}\n}\n';
    try {
      const put = await fetch(`${url}/api/studio-rail?root=${encodeURIComponent(tmp)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
      });
      expect(put.status).toBe(200);
      expect(await fs.readFile(railFile(tmp), "utf8")).toBe(raw);

      const get = await fetch(`${url}/api/studio-rail?root=${encodeURIComponent(tmp)}`);
      expect((await get.json()).raw).toBe(raw);
    } finally {
      await close();
    }
  });

  it("DELETEs the file, which is how an un-materialized state reaches disk", async () => {
    const { url, close } = await serve([tmp]);
    try {
      await writeStudioRailFile(tmp, "{}");
      const res = await fetch(`${url}/api/studio-rail?root=${encodeURIComponent(tmp)}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      await expect(fs.stat(railFile(tmp))).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("refuses a non-string body and an oversized one", async () => {
    const { url, close } = await serve([tmp]);
    try {
      const bad = await fetch(`${url}/api/studio-rail?root=${encodeURIComponent(tmp)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: { version: 1 } }),
      });
      expect(bad.status).toBe(400);

      const huge = await fetch(`${url}/api/studio-rail?root=${encodeURIComponent(tmp)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: "x".repeat(MAX_STUDIO_RAIL_BYTES + 1) }),
      });
      expect(huge.status).toBe(413);
      await expect(fs.stat(railFile(tmp))).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("serves launch edges without a root, and does not read a file for them", async () => {
    const gateway = path.join(tmp, "gateway");
    await fs.mkdir(gateway, { recursive: true });
    await fs.writeFile(
      path.join(gateway, "index.ts"),
      'await ctx.agents.launch({ definition: "queue" });\n',
      "utf8",
    );
    const { url, close } = await serve([tmp], [{ name: "gateway", path: gateway }]);
    try {
      const res = await fetch(`${url}/api/studio-rail/launch-edges`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ edges: [{ parent: "gateway", child: "queue" }] });
    } finally {
      await close();
    }
  });
});

describe("detectLaunchEdges", () => {
  const seed = async (name: string, source: string): Promise<{ name: string; path: string }> => {
    const dir = path.join(tmp, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "agent.ts"), source, "utf8");
    return { name, path: dir };
  };

  it("reads both SDK spellings of a launch call", async () => {
    const workflows = [
      await seed("current", 'agents.launch({ definition: "child-a" })'),
      await seed("legacy", 'orchestrations.launch({ definition: "child-b" })'),
    ];
    expect(await detectLaunchEdges(workflows)).toEqual([
      { parent: "current", child: "child-a" },
      { parent: "legacy", child: "child-b" },
    ]);
  });

  it("collapses the same definition launched from several steps into ONE edge", async () => {
    // A group is about the relationship, not its multiplicity.
    const workflow = await seed(
      "hub",
      'agents.launch({ definition: "worker" });\nagents.launch({ definition: "worker" });\n',
    );
    expect(await detectLaunchEdges([workflow])).toEqual([{ parent: "hub", child: "worker" }]);
  });

  it("drops a self-launch", async () => {
    const workflow = await seed("loop", 'agents.launch({ definition: "loop" })');
    expect(await detectLaunchEdges([workflow])).toEqual([]);
  });

  it("contributes nothing for a project whose directory is gone", async () => {
    expect(await detectLaunchEdges([{ name: "ghost", path: path.join(tmp, "ghost") }])).toEqual([]);
  });

  it("reports an edge to a definition no local agent provides — the client filters it", async () => {
    // The server's job is what the sources SAY. Whether both ends exist is a
    // question about the registry, and `buildGroupTree` answers it: an edge to
    // an agent this install lacks forms no group.
    const workflow = await seed("outreach", 'agents.launch({ definition: "ghost-agent" })');
    expect(await detectLaunchEdges([workflow])).toEqual([
      { parent: "outreach", child: "ghost-agent" },
    ]);
  });
});
