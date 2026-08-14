import { describe, expect, it, vi } from "vitest";
import { MAX_INLINE_ATTACHMENT_BYTES } from "@shared/types";

import {
  buildIdeaWithAttachments,
  filesToAttachments,
  materializeAttachments,
  mergeAttachments,
  type NewSessionAttachment,
} from "./new-session-attachments";

const pathAttachment = (id: string, path: string): NewSessionAttachment => ({
  id,
  kind: "path",
  name: path.split(/[\\/]/).pop() ?? path,
  path,
});

const inlineAttachment = (
  id: string,
  fingerprint: string,
): NewSessionAttachment => ({
  id,
  kind: "inline",
  name: "screenshot.png",
  mediaType: "image/png",
  bytes: 6,
  dataUrl: "data:image/png;base64,cGl4ZWxz",
  fingerprint,
});

describe("filesToAttachments", () => {
  it("uses a desktop path without reading or copying bytes", async () => {
    const file = new File(["not read"], "brief.pdf", {
      type: "application/pdf",
    });
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");

    const result = await filesToAttachments(
      [file],
      () => "/Users/me/My Files/brief.pdf",
    );

    expect(result.errors).toEqual([]);
    expect(result.attachments).toEqual([
      expect.objectContaining({
        kind: "path",
        name: "brief.pdf",
        path: "/Users/me/My Files/brief.pdf",
      }),
    ]);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("falls back to inline bytes for a pathless clipboard image", async () => {
    const result = await filesToAttachments([
      new File(["pixels"], "screenshot.png", { type: "image/png" }),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.attachments).toEqual([
      expect.objectContaining({
        kind: "inline",
        name: "screenshot.png",
        mediaType: "image/png",
        bytes: 6,
        dataUrl: "data:image/png;base64,cGl4ZWxz",
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
  });

  it("rejects a pathless file over 10 MiB with its filename", async () => {
    const result = await filesToAttachments([
      new File(
        [new Uint8Array(MAX_INLINE_ATTACHMENT_BYTES + 1)],
        "huge-screenshot.png",
        { type: "image/png" },
      ),
    ]);

    expect(result.attachments).toEqual([]);
    expect(result.errors).toEqual([
      expect.stringContaining("huge-screenshot.png"),
    ]);
  });

  it("rejects a file that would exceed the remaining inline queue budget", async () => {
    const result = await filesToAttachments(
      [new File(["four"], "second.txt", { type: "text/plain" })],
      undefined,
      3,
    );

    expect(result.attachments).toEqual([]);
    expect(result.errors).toEqual([expect.stringContaining("second.txt")]);
  });
});

describe("mergeAttachments", () => {
  it("deduplicates a repeated disk path while preserving selection order", () => {
    const first = pathAttachment("1", "/tmp/first.png");
    const duplicate = pathAttachment("2", "/tmp/first.png");
    const second = pathAttachment("3", "/tmp/second.pdf");

    expect(mergeAttachments([first], [duplicate, second])).toEqual([
      first,
      second,
    ]);
  });

  it("deduplicates repeated inline content even when queue ids differ", () => {
    const first = inlineAttachment("inline-1", "same-bytes");
    const duplicate = inlineAttachment("inline-2", "same-bytes");

    expect(mergeAttachments([first], [duplicate])).toEqual([first]);
  });
});

describe("materializeAttachments", () => {
  it("preserves mixed path and inline attachment order", async () => {
    const upload = vi.fn(async () => ({
      path: "/project/.sapiom/uploads/screenshot.png",
      mediaType: "image/png",
      bytes: 6,
    }));
    const inline = inlineAttachment("inline-1", "pixels");

    await expect(
      materializeAttachments(
        "session-1",
        [pathAttachment("path-1", "/tmp/brief.pdf"), inline],
        upload,
      ),
    ).resolves.toEqual([
      { name: "brief.pdf", path: "/tmp/brief.pdf" },
      {
        name: "screenshot.png",
        path: "/project/.sapiom/uploads/screenshot.png",
      },
    ]);
    expect(upload).toHaveBeenCalledWith("session-1", {
      filename: "screenshot.png",
      dataUrl: "data:image/png;base64,cGl4ZWxz",
    });
  });

  it("names the inline file when an upload fails and resolves no partial result", async () => {
    const upload = vi.fn().mockRejectedValue(new Error("disk full"));

    await expect(
      materializeAttachments(
        "session-1",
        [
          pathAttachment("path-1", "/tmp/brief.pdf"),
          inlineAttachment("inline-1", "pixels"),
        ],
        upload,
      ),
    ).rejects.toThrow("Couldn't attach screenshot.png: disk full");
  });
});

describe("buildIdeaWithAttachments", () => {
  it("preserves the idea and quotes a POSIX path with spaces", () => {
    expect(
      buildIdeaWithAttachments("Build this flow.", [
        { name: "flow.png", path: "/Users/me/My Files/flow.png" },
      ]),
    ).toBe(
      'Build this flow.\n\nAttached files (read each as context):\n"/Users/me/My Files/flow.png"',
    );
  });

  it("keeps a quoted Windows path's backslashes intact", () => {
    expect(
      buildIdeaWithAttachments("Build it.", [
        { name: "spec.pdf", path: "C:\\My Files\\spec.pdf" },
      ]),
    ).toBe(
      'Build it.\n\nAttached files (read each as context):\n"C:\\My Files\\spec.pdf"',
    );
  });

  it("supports an attachment-only request", () => {
    expect(
      buildIdeaWithAttachments("", [
        { name: "brief.pdf", path: "/tmp/brief.pdf" },
      ]),
    ).toBe("Attached files (read each as context):\n/tmp/brief.pdf");
  });

  it("keeps the existing no-idea path when there are no attachments", () => {
    expect(buildIdeaWithAttachments("", [])).toBeUndefined();
  });
});
