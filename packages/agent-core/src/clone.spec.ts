/**
 * Unit tests for `clone` (the template-clone handoff, SAP-1357, and the
 * definitionId clone-a-deployed-workflow path, SAP-1839).
 *
 * Fully offline: global.fetch is mocked for the fork/clone-token/definitions
 * calls, and the git clone is injected as a fake that only records its inputs
 * and materializes an empty target dir. The filesystem (a temp dir) is the
 * only real dependency.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "./client";
import { createTarGz } from "./tar";
import { clone } from "./clone";
import { CONFIG_FILE } from "./config";
import { AgentOperationError } from "./errors";
import type { CloneRepoOptions } from "./git";

/** `archive` for the raw-bytes download route; `body` for every JSON route. */
type MockResponse = { status: number; body?: unknown; archive?: Buffer };

function mockFetch(responses: MockResponse[]): jest.SpyInstance {
  let i = 0;
  return jest.spyOn(global, "fetch" as never).mockImplementation((async () => {
    const r = responses[i++] ?? responses[responses.length - 1];
    const text = JSON.stringify(r.body);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: r.status === 200 ? "OK" : "Error",
      text: async () => text,
      arrayBuffer: async () => {
        if (!r.archive) throw new Error("mockFetch: this response has no archive body.");
        return r.archive.buffer.slice(
          r.archive.byteOffset,
          r.archive.byteOffset + r.archive.byteLength,
        );
      },
    } as unknown as Response;
  }) as never);
}

function makeTmp(): string {
  return mkdtempSync(path.join(tmpdir(), "sapiom-clone-test-"));
}

const client = createClient({ host: "https://example.com", apiKey: "sk_test" });

const FORK_BODY = {
  id: "fork-uuid-1",
  templateId: "web-research-digest",
  repoFullName: "Sapiom-Platform/sapiom-fork-abc",
  defaultBranch: "main",
};
const TOKEN_BODY = {
  repoFullName: "Sapiom-Platform/sapiom-fork-abc",
  defaultBranch: "main",
  cloneUrl:
    "https://x-access-token:ghs_secretTOKEN@github.com/Sapiom-Platform/sapiom-fork-abc.git",
  expiresAt: "2026-07-07T01:00:00.000Z",
};
const DEFINITION_TOKEN_BODY = {
  repoFullName: "Sapiom-Platform/ag-uuid-1",
  defaultBranch: "main",
  cloneUrl:
    "https://x-access-token:ghs_secretTOKEN@github.com/Sapiom-Platform/ag-uuid-1.git",
  expiresAt: "2026-07-07T01:00:00.000Z",
};

/** A fake clone that just records its inputs and creates the target dir. */
function recordingClone(): {
  fn: (o: CloneRepoOptions) => void;
  calls: CloneRepoOptions[];
} {
  const calls: CloneRepoOptions[] = [];
  return {
    calls,
    fn: (o: CloneRepoOptions) => {
      calls.push(o);
      mkdirSync(o.targetDir, { recursive: true });
    },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("clone", () => {
  it("forks a template, mints a token, clones, and writes provenance", async () => {
    const spy = mockFetch([
      { status: 200, body: FORK_BODY },
      { status: 200, body: TOKEN_BODY },
    ]);
    const base = makeTmp();
    const target = path.join(base, "project");
    const rec = recordingClone();
    try {
      const result = await clone(
        {
          templateId: "web-research-digest",
          targetDir: target,
          cloneRepo: rec.fn,
        },
        client,
      );

      // Hits fork then clone-token, in order.
      const urls = spy.mock.calls.map((c) => (c as [string])[0]);
      expect(urls[0]).toBe(
        "https://example.com/v1/workflows/templates/web-research-digest/fork",
      );
      expect(urls[1]).toBe(
        "https://example.com/v1/workflows/forks/fork-uuid-1/clone-token",
      );

      // Clones with the minted URL and checks out the fork's default branch.
      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0].cloneUrl).toBe(TOKEN_BODY.cloneUrl);
      expect(rec.calls[0].branch).toBe("main");
      expect(rec.calls[0].targetDir).not.toBe(target);
      expect(path.dirname(rec.calls[0].targetDir)).toBe(base);

      // Result carries provenance but NEVER the credential.
      expect(result).toMatchObject({
        forkId: "fork-uuid-1",
        templateId: "web-research-digest",
        repoFullName: "Sapiom-Platform/sapiom-fork-abc",
        defaultBranch: "main",
        targetDir: target,
        tokenExpiresAt: "2026-07-07T01:00:00.000Z",
      });
      expect(JSON.stringify(result)).not.toContain("ghs_secretTOKEN");

      // sapiom.json records provenance, no definitionId (created at deploy), no token.
      const cfg = JSON.parse(
        readFileSync(path.join(target, CONFIG_FILE), "utf8"),
      );
      expect(cfg).toEqual({
        repoFullName: "Sapiom-Platform/sapiom-fork-abc",
        defaultBranch: "main",
        forkId: "fork-uuid-1",
        templateId: "web-research-digest",
      });
      expect(JSON.stringify(cfg)).not.toContain("ghs_secretTOKEN");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("clones an existing fork without forking (no templateId in config)", async () => {
    mockFetch([{ status: 200, body: TOKEN_BODY }]);
    const base = makeTmp();
    const target = path.join(base, "project");
    const rec = recordingClone();
    try {
      const result = await clone(
        { forkId: "fork-uuid-1", targetDir: target, cloneRepo: rec.fn },
        client,
      );

      expect(result.forkId).toBe("fork-uuid-1");
      expect(result.templateId).toBeUndefined();
      const cfg = JSON.parse(
        readFileSync(path.join(target, CONFIG_FILE), "utf8"),
      );
      expect(cfg.templateId).toBeUndefined();
      expect(cfg.forkId).toBe("fork-uuid-1");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("retries the GitHub branch-propagation window from a clean staged path", async () => {
    mockFetch([
      { status: 200, body: FORK_BODY },
      { status: 200, body: TOKEN_BODY },
    ]);
    const base = makeTmp();
    const target = path.join(base, "project");
    const cloneTargets: string[] = [];
    try {
      const result = await clone(
        {
          templateId: "web-research-digest",
          targetDir: target,
          cloneRepo: (opts) => {
            cloneTargets.push(opts.targetDir);
            if (cloneTargets.length === 1) {
              writeFileSync(path.join(opts.targetDir, "partial"), "partial");
              throw new AgentOperationError({
                code: "GIT_CLONE",
                message: "git clone failed.",
                hint: "fatal: Remote branch main not found in upstream origin",
              });
            }
            writeFileSync(path.join(opts.targetDir, "README.md"), "# cloned\n");
          },
        },
        client,
      );

      expect(result.forkId).toBe("fork-uuid-1");
      expect(cloneTargets).toHaveLength(2);
      expect(cloneTargets[1]).not.toBe(cloneTargets[0]);
      expect(readFileSync(path.join(target, "README.md"), "utf8")).toBe(
        "# cloned\n",
      );
      expect(readdirSync(base)).toEqual(["project"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("clones a deployed agent from its stored archive, with no repo and no git", async () => {
    // Since AGENT-289 a deploy uploads source and does not push, so the agent's
    // repo is empty or frozen. Cloning must read the archive, or it hands back
    // stale code with nothing to signal it.
    const archive = createTarGz([
      { path: "agent/index.ts", content: "export default 1;\n" },
      { path: "shared/util.ts", content: "export const util = 2;\n" },
      { path: ".sapiom-source.json", content: '{"entry":"agent/index.ts"}\n' },
    ]);
    const spy = mockFetch([{ status: 200, archive }]);
    const base = makeTmp();
    const target = path.join(base, "project");
    const rec = recordingClone();
    try {
      const result = await clone(
        { definitionId: "253", targetDir: target, cloneRepo: rec.fn },
        client,
      );

      // One request, to the source route. No fork, no clone-token, no credential.
      const urls = spy.mock.calls.map((c) => (c as [string])[0]);
      expect(urls).toEqual(["https://example.com/v1/workflows/definitions/253/source"]);
      expect(rec.calls).toHaveLength(0);

      // The nested layout is restored verbatim, so the relative import between
      // the two files still resolves in the checkout.
      expect(readFileSync(path.join(target, "agent", "index.ts"), "utf8")).toBe("export default 1;\n");
      expect(readFileSync(path.join(target, "shared", "util.ts"), "utf8")).toBe("export const util = 2;\n");

      // Pre-linked, and with no repo there is no repoFullName or branch to record.
      expect(result).toEqual({ definitionId: "253", targetDir: target });
      const cfg = JSON.parse(readFileSync(path.join(target, CONFIG_FILE), "utf8"));
      expect(cfg).toEqual({ definitionId: "253" });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("falls back to a git clone when archives are switched off (409)", async () => {
    // The engine ships with the flag OFF, so against a freshly deployed engine
    // EVERY clone gets a 409 — not a 404. Handling only 404 broke clone outright
    // at the exact stage of the rollout that is meant to change nothing.
    const spy = mockFetch([
      { status: 409, body: { message: "Source archives are disabled." } },
      { status: 200, body: DEFINITION_TOKEN_BODY },
    ]);
    const base = makeTmp();
    const target = path.join(base, "project");
    const rec = recordingClone();
    try {
      await clone({ definitionId: "253", targetDir: target, cloneRepo: rec.fn }, client);

      const urls = spy.mock.calls.map((c) => (c as [string])[0]);
      expect(urls).toEqual([
        "https://example.com/v1/workflows/definitions/253/source",
        "https://example.com/v1/workflows/definitions/253/clone-token",
      ]);
      expect(rec.calls).toHaveLength(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("does NOT fall back when the archive read is genuinely forbidden", async () => {
    // A 403 is a real error. Falling back would turn it into a stale checkout that
    // looks like a success, which is the failure mode this whole rewire exists to
    // remove.
    mockFetch([{ status: 403, body: { message: "no access" } }]);
    const base = makeTmp();
    const rec = recordingClone();
    try {
      await expect(
        clone({ definitionId: "253", targetDir: path.join(base, "project"), cloneRepo: rec.fn }, client),
      ).rejects.toMatchObject({ code: "HTTP_403" });
      expect(rec.calls).toHaveLength(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("falls back to a git clone when the agent has no stored archive", async () => {
    // An agent that only ever deployed through the push path, or an engine older
    // than the download route: 404 means "no archive", so the git clone still
    // runs and such an agent keeps cloning exactly as before.
    const spy = mockFetch([
      { status: 404, body: { message: "no source" } },
      { status: 200, body: DEFINITION_TOKEN_BODY },
    ]);
    const base = makeTmp();
    const target = path.join(base, "project");
    const rec = recordingClone();
    try {
      const result = await clone(
        { definitionId: "253", targetDir: target, cloneRepo: rec.fn },
        client,
      );

      // Tries the archive first, then the clone-token — and never forks.
      const urls = spy.mock.calls.map((c) => (c as [string])[0]);
      expect(urls).toEqual([
        "https://example.com/v1/workflows/definitions/253/source",
        "https://example.com/v1/workflows/definitions/253/clone-token",
      ]);

      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0].cloneUrl).toBe(DEFINITION_TOKEN_BODY.cloneUrl);
      expect(rec.calls[0].branch).toBe("main");

      // Result carries the definitionId, no forkId/templateId, no credential.
      expect(result).toMatchObject({
        definitionId: "253",
        repoFullName: "Sapiom-Platform/ag-uuid-1",
        defaultBranch: "main",
        targetDir: target,
      });
      expect(result.forkId).toBeUndefined();
      expect(result.templateId).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("ghs_secretTOKEN");

      // sapiom.json is pre-linked: definitionId present, no forkId, no token.
      const cfg = JSON.parse(
        readFileSync(path.join(target, CONFIG_FILE), "utf8"),
      );
      expect(cfg).toEqual({
        repoFullName: "Sapiom-Platform/ag-uuid-1",
        defaultBranch: "main",
        definitionId: "253",
      });
      expect(JSON.stringify(cfg)).not.toContain("ghs_secretTOKEN");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects when none of templateId, forkId, or definitionId is given", async () => {
    const spy = mockFetch([{ status: 200, body: {} }]);
    await expect(
      clone({ targetDir: "/tmp/whatever", cloneRepo: () => {} }, client),
    ).rejects.toMatchObject({
      code: "BAD_INPUT",
      message:
        "Provide a templateId (to fork then clone), a forkId (to clone an existing fork), or a definitionId (to clone a deployed agent).",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects when more than one of templateId, forkId, or definitionId is given", async () => {
    await expect(
      clone(
        {
          templateId: "t",
          forkId: "f",
          targetDir: "/tmp/whatever",
          cloneRepo: () => {},
        },
        client,
      ),
    ).rejects.toMatchObject({
      code: "BAD_INPUT",
      hint: "Use templateId to start from a gallery template, forkId to re-clone an existing fork, or definitionId to pull a deployed agent locally.",
    });
    await expect(
      clone(
        {
          templateId: "t",
          definitionId: "1",
          targetDir: "/tmp/whatever",
          cloneRepo: () => {},
        },
        client,
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    await expect(
      clone(
        {
          forkId: "f",
          definitionId: "1",
          targetDir: "/tmp/whatever",
          cloneRepo: () => {},
        },
        client,
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
  });

  it("rejects a non-empty target directory before any network call", async () => {
    const base = makeTmp();
    const target = path.join(base, "project");
    mkdirSync(target, { recursive: true });
    // Make it non-empty.
    mkdirSync(path.join(target, "sub"));
    const spy = mockFetch([{ status: 200, body: {} }]);
    try {
      await expect(
        clone({ forkId: "f", targetDir: target, cloneRepo: () => {} }, client),
      ).rejects.toMatchObject({
        code: "DIR_NOT_EMPTY",
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("preserves Agent Studio's private .sapiom directory while cloning", async () => {
    mockFetch([{ status: 200, body: TOKEN_BODY }]);
    const base = makeTmp();
    const target = path.join(base, "project");
    const studioState = path.join(target, ".sapiom");
    mkdirSync(studioState, { recursive: true });
    writeFileSync(
      path.join(studioState, "harness-context.json"),
      '{"session":"studio"}\n',
    );
    let actualCloneTarget = "";

    try {
      await clone(
        {
          forkId: "fork-uuid-1",
          targetDir: target,
          cloneRepo: (opts) => {
            actualCloneTarget = opts.targetDir;
            mkdirSync(opts.targetDir, { recursive: true });
            mkdirSync(path.join(opts.targetDir, ".git"));
            writeFileSync(path.join(opts.targetDir, "README.md"), "# cloned\n");
          },
        },
        client,
      );

      expect(actualCloneTarget).not.toBe(target);
      expect(
        readFileSync(path.join(studioState, "harness-context.json"), "utf8"),
      ).toBe('{"session":"studio"}\n');
      expect(readFileSync(path.join(target, "README.md"), "utf8")).toBe(
        "# cloned\n",
      );
      expect(readdirSync(base)).toEqual(["project"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("leaves Agent Studio state untouched when a staged clone fails", async () => {
    mockFetch([{ status: 200, body: TOKEN_BODY }]);
    const base = makeTmp();
    const target = path.join(base, "project");
    const studioState = path.join(target, ".sapiom");
    mkdirSync(studioState, { recursive: true });
    writeFileSync(path.join(studioState, "session.json"), '{"id":"studio"}\n');

    try {
      await expect(
        clone(
          {
            forkId: "fork-uuid-1",
            targetDir: target,
            cloneRepo: (opts) => {
              writeFileSync(
                path.join(opts.targetDir, "partial.txt"),
                "partial",
              );
              throw new Error("clone failed");
            },
          },
          client,
        ),
      ).rejects.toThrow("clone failed");

      expect(readFileSync(path.join(studioState, "session.json"), "utf8")).toBe(
        '{"id":"studio"}\n',
      );
      expect(readdirSync(target)).toEqual([".sapiom"]);
      expect(readdirSync(base)).toEqual(["project"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects a non-https clone URL from the endpoint (never handed to git)", async () => {
    mockFetch([
      {
        status: 200,
        body: { ...TOKEN_BODY, cloneUrl: "--upload-pack=touch /tmp/pwned" },
      },
    ]);
    const base = makeTmp();
    const target = path.join(base, "project");
    const rec = recordingClone();
    try {
      await expect(
        clone({ forkId: "f", targetDir: target, cloneRepo: rec.fn }, client),
      ).rejects.toMatchObject({
        code: "BAD_CLONE_URL",
      });
      expect(rec.calls).toHaveLength(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("surfaces a gateway error from the fork call", async () => {
    mockFetch([{ status: 404, body: { message: "No such template" } }]);
    const base = makeTmp();
    try {
      await expect(
        clone(
          {
            templateId: "missing",
            targetDir: path.join(base, "p"),
            cloneRepo: () => {},
          },
          client,
        ),
      ).rejects.toMatchObject({ code: "HTTP_404" });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
