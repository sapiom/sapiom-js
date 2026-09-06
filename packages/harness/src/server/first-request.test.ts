import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareFirstRequest } from "./first-request.js";
import type { AgentScaffoldDeps } from "./scaffold.js";

let root: string;
let deps: AgentScaffoldDeps;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-first-request-"));
  deps = {
    listProjectDirs: () => [root],
    resolveAgent: () => null,
    scaffoldAgent: vi.fn(async ({ targetDir }) => {
      await writeFile(join(targetDir, "AGENTS.md"), "Project instructions");
      return { dependenciesInstalled: true };
    }),
    onScaffolded: vi.fn(async () => {}),
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("scaffolds with the existing server guards, then returns only the user's first task", async () => {
  const cwd = join(root, "ticket-triage");
  const prompt = "--help\nBuild a local support-ticket triage project.";
  expect(
    await prepareFirstRequest(
      {
        cwd,
        harness: "claude-code",
        scaffold: { template: "default" },
        initialPrompt: prompt,
      },
      deps,
    ),
  ).toBe(prompt);
  expect(deps.scaffoldAgent).toHaveBeenCalledExactlyOnceWith({
    targetDir: cwd,
    template: "default",
  });
  expect(deps.onScaffolded).toHaveBeenCalledExactlyOnceWith(cwd);
  expect(await readFile(join(cwd, "AGENTS.md"), "utf8")).toBe(
    "Project instructions",
  );
});

it("materializes clipboard bytes and preserves mixed attachment order before launch", async () => {
  const cwd = join(root, "ticket-triage");
  const prompt = await prepareFirstRequest(
    {
      cwd,
      harness: "codex",
      scaffold: { template: "default" },
      initialPrompt: "Use my files.",
      initialAttachments: [
        { kind: "path", path: "/native/first brief.pdf" },
        {
          kind: "inline",
          filename: "../../screenshot.PNG",
          dataUrl: "data:image/png;base64,cGl4ZWxz",
        },
        { kind: "path", path: "/native/last.txt" },
      ],
    },
    deps,
  );
  const [upload] = await readdir(join(cwd, ".sapiom/uploads"));
  const uploadedPath = join(cwd, ".sapiom/uploads", upload!);
  expect(upload).toMatch(/^[a-f0-9-]+\.png$/);
  expect(await readFile(uploadedPath, "utf8")).toBe("pixels");
  expect(prompt).toBe(
    `Use my files.\n\nAttached files (read each as context):\n"/native/first brief.pdf"\n${uploadedPath}\n/native/last.txt`,
  );
});

it("rejects invalid attachments before creating the project or starting a session", async () => {
  await expect(
    prepareFirstRequest(
      {
        cwd: join(root, "invalid"),
        harness: "claude-code",
        scaffold: { template: "default" },
        initialAttachments: [
          {
            kind: "inline",
            filename: "bad.txt",
            dataUrl: "data:text/plain;base64,not base64",
          },
        ],
      },
      deps,
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(deps.scaffoldAgent).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});

it("refuses an unregistered parent and never overwrites an existing project", async () => {
  await expect(
    prepareFirstRequest(
      {
        cwd: join(root, "unregistered", "agent"),
        harness: "claude-code",
        scaffold: { template: "default" },
      },
      deps,
    ),
  ).rejects.toMatchObject({ status: 409 });
  const request = {
    cwd: join(root, "agent"),
    harness: "claude-code" as const,
    scaffold: { template: "default" },
  };
  await prepareFirstRequest(request, deps);
  await expect(prepareFirstRequest(request, deps)).rejects.toMatchObject({
    status: 409,
  });
  expect(deps.scaffoldAgent).toHaveBeenCalledOnce();
});

it("an attachment-only request supplies context without a synthetic scaffold instruction", async () => {
  expect(
    await prepareFirstRequest(
      {
        cwd: root,
        harness: "claude-code",
        initialAttachments: [{ kind: "path", path: "/native/brief.txt" }],
      },
      deps,
    ),
  ).toBe("Attached files (read each as context):\n/native/brief.txt");
  expect(deps.scaffoldAgent).not.toHaveBeenCalled();
});
