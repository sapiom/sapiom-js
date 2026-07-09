/**
 * Skills router tests.
 *
 * Two skill sources:
 *   - Package skills: node_modules/@sapiom/<pkg>/skills/<id>/SKILL.md
 *   - User skills:    <userRoot>/<id>/SKILL.md
 *
 * All tests use an isolated tmp directory tree — no network, no real home.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import express from "express";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { createSkillsRouter } from "./skills.js";
import type { SkillMeta, SkillDetail } from "./skills.js";

let tmpDir: string;
let nmRoot: string;    // node_modules root
let userRoot: string;  // user skills root (~/.claude/skills equivalent)
let server: ReturnType<express.Express["listen"]>;
let baseUrl: string;

/** Write a SKILL.md at root/<dir>/SKILL.md (creating intermediate directories). */
async function writeSkill(
  rootDir: string,
  id: string,
  content: string,
): Promise<void> {
  const dir = path.join(rootDir, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), content, "utf-8");
}

function start(nmOverride?: string, userOverride?: string): Promise<void> {
  const app = express();
  app.use(
    createSkillsRouter({
      nodeModulesRoot: nmOverride ?? nmRoot,
      userSkillsRoot: userOverride ?? userRoot,
    }),
  );
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-skills-test-"));
  nmRoot = path.join(tmpDir, "node_modules");
  userRoot = path.join(tmpDir, "user-skills");
  await fs.mkdir(nmRoot, { recursive: true });
  await fs.mkdir(userRoot, { recursive: true });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GET /api/skills — listing
// ---------------------------------------------------------------------------

describe("GET /api/skills", () => {
  it("returns an empty array when no skills exist", async () => {
    await start();
    const res = await fetch(`${baseUrl}/api/skills`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("lists skills from the user skills directory", async () => {
    await writeSkill(
      userRoot,
      "my-skill",
      `---\nname: My Skill\ndescription: Does something useful\n---\n\n# Body`,
    );
    await start();
    const res = await fetch(`${baseUrl}/api/skills`);
    expect(res.status).toBe(200);
    const skills = (await res.json()) as SkillMeta[];
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      id: "my-skill",
      name: "My Skill",
      description: "Does something useful",
      source: "user",
    });
  });

  it("lists skills from installed @sapiom/* packages", async () => {
    const sapiomPkgSkills = path.join(nmRoot, "@sapiom", "core", "skills");
    await writeSkill(
      sapiomPkgSkills,
      "pkg-skill",
      `---\nname: Package Skill\ndescription: Shipped with a package\n---\n\n# Content`,
    );
    await start();
    const res = await fetch(`${baseUrl}/api/skills`);
    const skills = (await res.json()) as SkillMeta[];
    const found = skills.find((s) => s.id === "pkg-skill");
    expect(found).toBeDefined();
    expect(found?.source).toBe("package");
    expect(found?.name).toBe("Package Skill");
  });

  it("merges skills from both sources", async () => {
    const sapiomPkgSkills = path.join(nmRoot, "@sapiom", "tools", "skills");
    await writeSkill(sapiomPkgSkills, "pkg-a", `---\nname: Pkg A\ndescription: From package\n---\n`);
    await writeSkill(userRoot, "user-b", `---\nname: User B\ndescription: From user\n---\n`);
    await start();
    const res = await fetch(`${baseUrl}/api/skills`);
    const skills = (await res.json()) as SkillMeta[];
    const ids = skills.map((s) => s.id);
    expect(ids).toContain("pkg-a");
    expect(ids).toContain("user-b");
  });

  it("user skill wins on id collision with a package skill", async () => {
    const sapiomPkgSkills = path.join(nmRoot, "@sapiom", "core", "skills");
    await writeSkill(sapiomPkgSkills, "shared-id", `---\nname: Package Version\ndescription: From pkg\n---\n`);
    await writeSkill(userRoot, "shared-id", `---\nname: User Version\ndescription: From user\n---\n`);
    await start();
    const res = await fetch(`${baseUrl}/api/skills`);
    const skills = (await res.json()) as SkillMeta[];
    const found = skills.filter((s) => s.id === "shared-id");
    // Exactly one entry for the id.
    expect(found).toHaveLength(1);
    // User wins.
    expect(found[0].name).toBe("User Version");
    expect(found[0].source).toBe("user");
  });

  it("handles a missing @sapiom directory gracefully (no installed packages)", async () => {
    // nmRoot exists but has no @sapiom subdirectory.
    await start();
    const res = await fetch(`${baseUrl}/api/skills`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("handles a missing user skills directory gracefully", async () => {
    await fs.rm(userRoot, { recursive: true, force: true });
    await start();
    const res = await fetch(`${baseUrl}/api/skills`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("falls back to the directory name when the frontmatter lacks a name field", async () => {
    await writeSkill(userRoot, "no-name-skill", `---\ndescription: Only a description\n---\n`);
    await start();
    const res = await fetch(`${baseUrl}/api/skills`);
    const skills = (await res.json()) as SkillMeta[];
    const found = skills.find((s) => s.id === "no-name-skill");
    expect(found?.name).toBe("no-name-skill");
  });

  it("does not expose file paths in the list response", async () => {
    await writeSkill(userRoot, "safe-skill", `---\nname: Safe\ndescription: OK\n---\n`);
    await start();
    const res = await fetch(`${baseUrl}/api/skills`);
    const skills = (await res.json()) as unknown[];
    for (const skill of skills) {
      expect(JSON.stringify(skill)).not.toContain(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/skills/:id — detail
// ---------------------------------------------------------------------------

describe("GET /api/skills/:id", () => {
  it("returns full detail with the markdown body (frontmatter stripped)", async () => {
    await writeSkill(
      userRoot,
      "authoring",
      `---\nname: Authoring\ndescription: Guides agent authoring\n---\n\n# How to write agents\n\nStep 1.`,
    );
    await start();
    const res = await fetch(`${baseUrl}/api/skills/authoring`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as SkillDetail;
    expect(detail.id).toBe("authoring");
    expect(detail.name).toBe("Authoring");
    expect(detail.body).toContain("How to write agents");
    expect(detail.body).toContain("Step 1.");
    // Frontmatter block must not appear in the body.
    expect(detail.body).not.toContain("---");
  });

  it("404s an unknown skill id", async () => {
    await start();
    const res = await fetch(`${baseUrl}/api/skills/does-not-exist`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("does-not-exist");
  });

  it("404s a path-traversal-shaped id (e.g. ../etc/passwd)", async () => {
    await start();
    // URL-encoded path traversal — server must reject without touching the fs.
    const res = await fetch(`${baseUrl}/api/skills/..%2Fetc%2Fpasswd`);
    expect(res.status).toBe(404);
  });

  it("404s an id with a slash (forward slash) — never a path segment", async () => {
    await start();
    const res = await fetch(`${baseUrl}/api/skills/some%2Fnested`);
    expect(res.status).toBe(404);
  });

  it("404s an id with a null byte", async () => {
    await start();
    const res = await fetch(`${baseUrl}/api/skills/evil%00byte`);
    expect(res.status).toBe(404);
  });

  it("resolves a package skill by id", async () => {
    const sapiomPkgSkills = path.join(nmRoot, "@sapiom", "agent", "skills");
    await writeSkill(
      sapiomPkgSkills,
      "pkg-detail",
      `---\nname: Pkg Detail\ndescription: A package skill\n---\n\n# Package content`,
    );
    await start();
    const res = await fetch(`${baseUrl}/api/skills/pkg-detail`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as SkillDetail;
    expect(detail.source).toBe("package");
    expect(detail.body).toContain("Package content");
  });
});

// ---------------------------------------------------------------------------
// Macro quoting — path with spaces does not split into shell words
// ---------------------------------------------------------------------------

describe("macro path quoting", () => {
  it("deploy macro uses the unquoted {{workflow.path}} placeholder (quoting applied at resolution time)", async () => {
    // The template itself stores the raw placeholder; POSIX single-quote
    // escaping is applied by shellQuote() in macro-runner.ts at resolution
    // time — so the template must NOT contain outer quotes around the token.
    const { DEFAULT_MACROS } = await import("../core/macros.js");
    const deploy = DEFAULT_MACROS.find((m) => m.id === "deploy");
    expect(deploy).toBeDefined();
    expect(deploy?.action.kind).toBe("inject");
    if (deploy?.action.kind === "inject") {
      // Template stores the bare placeholder — no surrounding quotes.
      expect(deploy.action.text).toContain("{{workflow.path}}");
      expect(deploy.action.text).not.toMatch(/"{{workflow\.path}}"/);
    }
  });

  it("resolving deploy against a path with spaces produces a POSIX single-quoted cd command", async () => {
    const { resolveMacro } = await import("../core/macro-runner.js");
    const { DEFAULT_MACROS } = await import("../core/macros.js");
    const deploy = DEFAULT_MACROS.find((m) => m.id === "deploy")!;

    const resolved = resolveMacro(deploy, {
      workflow: {
        name: "my workflow",
        path: "/Users/demo/my workflow",
        definitionId: null,
        source: "scan",
      },
      sessionCwd: "/Users/demo",
      canvasPath: "/Users/demo/.sapiom/canvas/index.html",
    });

    expect(resolved.kind).toBe("inject");
    if (resolved.kind === "inject") {
      // POSIX single-quoting stops spaces and metacharacters — the shell
      // sees a single token even with spaces or dollar signs in the path.
      expect(resolved.text).toBe("cd '/Users/demo/my workflow' && sapiom agents deploy");
    }
  });
});
