import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { prepareFirstRequest } from "./first-request.js";

let root: string;
let cwd: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-first-request-"));
  cwd = join(root, "ticket-triage");
  await mkdir(cwd);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("returns the user's first task verbatim, with nothing added", async () => {
  const prompt = "--help\nBuild a local support-ticket triage project.";
  expect(
    await prepareFirstRequest({
      cwd,
      harness: "claude-code",
      initialPrompt: prompt,
    }),
  ).toBe(prompt);
  // No session-side scaffold any more: the harness created the agent through
  // POST /api/agents/scaffold before this session was requested, so preparing
  // the first turn writes nothing but the uploads it was handed.
  expect(await readdir(cwd)).toEqual([]);
});

it("materializes clipboard bytes and preserves mixed attachment order before launch", async () => {
  const prompt = await prepareFirstRequest({
    cwd,
    harness: "codex",
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
  });
  const [upload] = await readdir(join(cwd, ".sapiom/uploads"));
  const uploadedPath = join(cwd, ".sapiom/uploads", upload!);
  expect(upload).toMatch(/^[a-f0-9-]+\.png$/);
  expect(await readFile(uploadedPath, "utf8")).toBe("pixels");
  expect(prompt).toBe(
    `Use my files.\n\nAttached files (read each as context):\n"/native/first brief.pdf"\n${uploadedPath}\n/native/last.txt`,
  );
});

it("composes the first turn in one order: idea, files, linked sources, session setup", async () => {
  // flow-creation.md §4.4 step 3: the idea, the resources, then the planning
  // instructions as setup. The user's words lead; the harness's follow.
  const prompt = await prepareFirstRequest({
    cwd,
    harness: "claude-code",
    initialPrompt: "Diff our competitors' pricing pages weekly.",
    initialAttachments: [{ kind: "path", path: "/native/brief.txt" }],
    initialSources: ["https://example.com/pricing", "https://docs.example.com/"],
    initialSetup: "Session setup. Plan before you build.",
  });
  expect(prompt).toBe(
    [
      "Diff our competitors' pricing pages weekly.",
      "Attached files (read each as context):\n/native/brief.txt",
      "Linked sources (read each as context):\nhttps://example.com/pricing\nhttps://docs.example.com/",
      "Session setup. Plan before you build.",
    ].join("\n\n"),
  );
});

it("rejects invalid attachments before starting a session", async () => {
  await expect(
    prepareFirstRequest({
      cwd,
      harness: "claude-code",
      initialAttachments: [
        {
          kind: "inline",
          filename: "bad.txt",
          dataUrl: "data:text/plain;base64,not base64",
        },
      ],
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect(await readdir(cwd)).toEqual([]);
});

it("an attachment-only request supplies context without a synthetic instruction", async () => {
  expect(
    await prepareFirstRequest({
      cwd,
      harness: "claude-code",
      initialAttachments: [{ kind: "path", path: "/native/brief.txt" }],
    }),
  ).toBe("Attached files (read each as context):\n/native/brief.txt");
});

it("an empty request has no first turn at all", async () => {
  expect(
    await prepareFirstRequest({ cwd, harness: "claude-code" }),
  ).toBeUndefined();
});
