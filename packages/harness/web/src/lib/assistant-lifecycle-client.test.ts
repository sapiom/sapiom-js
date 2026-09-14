import { describe, expect, it } from "vitest";
import {
  parseAssistantAttachment,
  parseAssistantLifecycle,
} from "./assistant-lifecycle-client";

const lifecycle = {
  version: 1,
  harnessSessionId: "studio-a",
  revision: 2,
  lifecycle: "open",
  execution: "paused",
  updatedAt: 1,
};
const attachment = {
  conversationId: "ses_native",
  lease: "66a6fce1-6e44-4b08-a12c-b53b4de97480",
  lifecycle,
};

describe("Assistant lifecycle transport", () => {
  it("reads the exact Studio lifecycle without adopting arbitrary wire fields", () => {
    expect(
      parseAssistantLifecycle({ ...lifecycle, secret: "ignored" }, "studio-a"),
    ).toEqual(lifecycle);
    expect(parseAssistantLifecycle(lifecycle, "studio-b")).toBeNull();
  });
  it.each([
    { revision: -1 },
    { revision: 0.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { lifecycle: "running" },
    { execution: "true" },
    { updatedAt: "yesterday" },
    { version: 2 },
  ])("rejects malformed lifecycle %j", (patch) => {
    expect(
      parseAssistantLifecycle({ ...lifecycle, ...patch }, "studio-a"),
    ).toBeNull();
  });
  it("accepts existing or newly committed attachment revisions", () => {
    expect(parseAssistantAttachment(attachment, "studio-a", 2)).toEqual(
      attachment,
    );
    expect(parseAssistantAttachment(attachment, "studio-a", 1)).toEqual(
      attachment,
    );
  });
  it.each([0, 3])(
    "rejects an attachment from another operation revision %i",
    (expected) => {
      expect(
        parseAssistantAttachment(attachment, "studio-a", expected),
      ).toBeNull();
    },
  );
  it("rejects ended, foreign, and unleased attachments", () => {
    expect(parseAssistantAttachment(attachment, "studio-b", 2)).toBeNull();
    expect(
      parseAssistantAttachment(
        { ...attachment, lifecycle: { ...lifecycle, lifecycle: "ended" } },
        "studio-a",
        2,
      ),
    ).toBeNull();
    expect(
      parseAssistantAttachment(
        { ...attachment, lease: "not-a-lease" },
        "studio-a",
        2,
      ),
    ).toBeNull();
    expect(
      parseAssistantAttachment(
        { ...attachment, conversationId: "studio-a" },
        "studio-a",
        2,
      ),
    ).toBeNull();
  });
});
