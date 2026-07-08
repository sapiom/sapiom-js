/**
 * Unit tests for the scaffold operation.
 *
 * These tests are fully local — no network calls. They use a temp directory
 * for the target so the filesystem is the only external dependency.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentOperationError } from "../errors";
import { registryFor, scaffold } from "../scaffold";

// Point template resolution at the bundled templates dir (two levels up from
// src/), bypassing the dist/ path that TEMPLATES_DIR normally expects.
const FIXTURE_TEMPLATES = path.resolve(__dirname, "..", "..", "templates");

beforeEach(() => {
  process.env.SAPIOM_TEMPLATES_DIR = FIXTURE_TEMPLATES;
});

afterEach(() => {
  delete process.env.SAPIOM_TEMPLATES_DIR;
});

function makeTmp(): string {
  return mkdtempSync(path.join(tmpdir(), "sapiom-scaffold-test-"));
}

describe("scaffold", () => {
  it("creates the target directory and applies replacements", async () => {
    const base = makeTmp();
    const targetDir = path.join(base, "my-orch");
    try {
      const result = await scaffold({
        targetDir,
        template: "default",
        projectName: "my-orch",
        versions: { agent: "1.0.0", tools: "1.0.0", zod: "3.0.0" },
      });

      expect(result.targetDir).toBe(targetDir);
      expect(result.projectName).toBe("my-orch");
      expect(result.template).toBe("default");
      expect(existsSync(path.join(targetDir, "index.ts"))).toBe(true);

      // Replacements applied: __PROJECT_NAME__ → my-orch in package.json
      const pkg = JSON.parse(
        readFileSync(path.join(targetDir, "package.json"), "utf8"),
      );
      expect(pkg.name).toBe("my-orch");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("initializes a git repository with an initial commit (so the project is deployable)", async () => {
    const base = makeTmp();
    const targetDir = path.join(base, "git-init");
    try {
      const result = await scaffold({
        targetDir,
        versions: { agent: "1.0.0", tools: "1.0.0", zod: "3.0.0" },
      });

      expect(result.gitInitialized).toBe(true);
      expect(existsSync(path.join(targetDir, ".git"))).toBe(true);
      // A commit exists — deploy's assertDeployable requires at least one.
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: targetDir,
        encoding: "utf8",
      }).trim();
      expect(head).toMatch(/^[0-9a-f]{7,}$/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("defaults projectName to path.basename(targetDir)", async () => {
    const base = makeTmp();
    const targetDir = path.join(base, "auto-named");
    try {
      const result = await scaffold({
        targetDir,
        versions: { agent: "1.0.0", tools: "1.0.0", zod: "3.0.0" },
      });
      expect(result.projectName).toBe("auto-named");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("throws DIR_NOT_EMPTY when target exists and is non-empty", async () => {
    const targetDir = makeTmp();
    // mkdtempSync creates a non-empty-ish dir — add a file to be sure
    writeFileSync(path.join(targetDir, "existing.txt"), "x");
    try {
      await expect(
        scaffold({
          targetDir,
          versions: { agent: "1.0.0", tools: "1.0.0", zod: "3.0.0" },
        }),
      ).rejects.toMatchObject({ code: "DIR_NOT_EMPTY" });
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("throws UNKNOWN_TEMPLATE for a non-existent template", async () => {
    const base = makeTmp();
    const targetDir = path.join(base, "no-template");
    try {
      await expect(
        scaffold({
          targetDir,
          template: "does-not-exist",
          versions: { agent: "1.0.0", tools: "1.0.0", zod: "3.0.0" },
        }),
      ).rejects.toMatchObject({ code: "UNKNOWN_TEMPLATE" });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("renames _gitignore to .gitignore", async () => {
    const base = makeTmp();
    const targetDir = path.join(base, "dotfile-test");
    try {
      await scaffold({
        targetDir,
        versions: { agent: "1.0.0", tools: "1.0.0", zod: "3.0.0" },
      });
      expect(existsSync(path.join(targetDir, ".gitignore"))).toBe(true);
      expect(existsSync(path.join(targetDir, "_gitignore"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("registryFor", () => {
  const saved = {
    registry: process.env.npm_config_registry,
    scoped: process.env["npm_config_@sapiom:registry"],
  };
  afterEach(() => {
    if (saved.registry === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = saved.registry;
    if (saved.scoped === undefined)
      delete process.env["npm_config_@sapiom:registry"];
    else process.env["npm_config_@sapiom:registry"] = saved.scoped;
  });

  it("defaults to public npm when no override is set", () => {
    delete process.env.npm_config_registry;
    delete process.env["npm_config_@sapiom:registry"];
    expect(registryFor("@sapiom/tools")).toBe("https://registry.npmjs.org");
  });

  it("honors the global npm_config_registry and strips a trailing slash", () => {
    delete process.env["npm_config_@sapiom:registry"];
    process.env.npm_config_registry = "http://localhost:4873/";
    expect(registryFor("@sapiom/tools")).toBe("http://localhost:4873");
  });

  it("prefers a scoped @scope:registry over the global one", () => {
    process.env.npm_config_registry = "http://localhost:4873";
    process.env["npm_config_@sapiom:registry"] = "http://localhost:9999";
    expect(registryFor("@sapiom/tools")).toBe("http://localhost:9999");
    // A different scope ignores the @sapiom-scoped override.
    expect(registryFor("@other/pkg")).toBe("http://localhost:4873");
  });
});

describe("scaffold .npmrc (local registry)", () => {
  const savedFetch = global.fetch;
  const savedRegistry = process.env.npm_config_registry;
  afterEach(() => {
    global.fetch = savedFetch;
    if (savedRegistry === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = savedRegistry;
  });

  it("writes an @sapiom:registry .npmrc when versions resolve from a non-default registry", async () => {
    process.env.npm_config_registry = "http://localhost:4873";
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({ version: "9.9.9" }),
    })) as unknown as typeof fetch;
    const base = makeTmp();
    const targetDir = path.join(base, "local-reg");
    try {
      await scaffold({ targetDir }); // no explicit versions → resolveVersions runs
      const npmrc = readFileSync(path.join(targetDir, ".npmrc"), "utf8");
      expect(npmrc).toContain("@sapiom:registry=http://localhost:4873");
      const pkg = JSON.parse(
        readFileSync(path.join(targetDir, "package.json"), "utf8"),
      );
      expect(pkg.dependencies["@sapiom/tools"]).toBe("9.9.9");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("does NOT write an .npmrc when resolving from the default registry", async () => {
    delete process.env.npm_config_registry;
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({ version: "9.9.9" }),
    })) as unknown as typeof fetch;
    const base = makeTmp();
    const targetDir = path.join(base, "default-reg");
    try {
      await scaffold({ targetDir });
      expect(existsSync(path.join(targetDir, ".npmrc"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("AgentOperationError", () => {
  it("serialises to a StructuredError shape", () => {
    const err = new AgentOperationError({
      code: "TEST",
      message: "msg",
      hint: "fix it",
    });
    expect(err.toStructured()).toEqual({
      code: "TEST",
      message: "msg",
      hint: "fix it",
    });
    expect(err.name).toBe("AgentOperationError");
  });
});
