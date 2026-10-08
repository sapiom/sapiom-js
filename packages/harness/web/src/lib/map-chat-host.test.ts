import { describe, expect, it } from "vitest";

import type { OpenCodeTurnMessage } from "../../../src/shared/opencode-turn";
import { askPrompt } from "./map-ask";
import {
  handoffArgs,
  latestTurnOffersHandoff,
  mapChatHostKey,
  mapChatTranscript,
} from "./map-chat-host";

const user = (id: string, text: string, agent = "build"): OpenCodeTurnMessage => ({
  info: { id, role: "user", agent, time: { created: 1 } },
  parts: [{ type: "text", text }],
});
const reply = (
  id: string,
  parentID: string,
  parts: OpenCodeTurnMessage["parts"],
): OpenCodeTurnMessage => ({
  info: { id, role: "assistant", parentID, agent: "build", time: { created: 2, completed: 3 } },
  parts,
});
const handoff = (status = "completed", input: unknown = { title: "Add a step", prompt: "Do it" }) => ({
  type: "tool",
  tool: "handoff",
  state: { status, input },
});

describe("map-chat-host", () => {
  it("keys the map chat by project, never as a session id", () => {
    expect(mapChatHostKey("proj_1")).toBe("map:proj_1");
  });

  it("reads the hand-off's two arguments only once both exist", () => {
    expect(handoffArgs({ title: " T ", prompt: " P " })).toEqual({ title: "T", prompt: "P" });
    expect(handoffArgs({ title: "T" })).toBeNull();
    expect(handoffArgs({ title: "", prompt: "P" })).toBeNull();
    expect(handoffArgs(null)).toBeNull();
  });

  it("knows when the latest turn ended in a hand-off", () => {
    const offered = [user("u1", "build it"), reply("a1", "u1", [handoff()]), reply("a2", "u1", [{ type: "text", text: "I offered a session." }])];
    expect(latestTurnOffersHandoff(offered)).toBe(true);
    // A later question starts a turn that has not offered one.
    expect(latestTurnOffersHandoff([...offered, user("u2", "and?"), reply("a3", "u2", [{ type: "text", text: "Sure." }])])).toBe(false);
    // A recovery turn belongs to the turn before it.
    expect(latestTurnOffersHandoff([...offered, user("u3", "finish", "sapiom-final-response")])).toBe(true);
    // A failed or argument-less call is not an offer.
    expect(latestTurnOffersHandoff([user("u1", "x"), reply("a1", "u1", [handoff("error")])])).toBe(false);
    expect(latestTurnOffersHandoff([user("u1", "x"), reply("a1", "u1", [handoff("running", { title: "T" })])])).toBe(false);
  });

  it("writes the transcript without Studio's bookkeeping", () => {
    const subject = { name: "tenant-screening", kind: "agent", path: "/p/tenant-screening" };
    const markdown = mapChatTranscript({
      projectLabel: "property-ops",
      projectRoot: "/p",
      selection: subject,
      messages: [
        user("u1", askPrompt("What does it check?", subject)),
        reply("a1", "u1", [{ type: "text", text: "<!-- studio-result:abc:finished -->\nCredit and history." }]),
        user("u2", "internal", "sapiom-turn-recovery"),
        user("u3", "Add a step"),
        reply("a3", "u3", [handoff()]),
      ],
    });
    expect(markdown).toContain("Selection: Asking about tenant-screening · agent, at /p/tenant-screening");
    expect(markdown).toContain("_Asking about tenant-screening · agent, at /p/tenant-screening_\n\nWhat does it check?");
    expect(markdown).toContain("Credit and history.");
    expect(markdown).not.toContain("studio-result");
    expect(markdown).not.toContain("internal");
    expect(markdown).toContain("Offered a session: **Add a step**");
  });
});
