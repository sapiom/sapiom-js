import { describe, expect, it } from "vitest";

import {
  askChipLabel,
  askKindForNode,
  askPlaceholder,
  askPrompt,
  parseAskPrompt,
  type AskSubject,
} from "./map-ask";

const agent: AskSubject = {
  name: "tenant-screening",
  kind: "agent",
  path: "/Users/demo/property-ops/tenant-screening",
};

describe("map-ask", () => {
  it("names the kind a picked node is asked about as", () => {
    expect(askKindForNode("agent", true)).toBe("agent");
    expect(askKindForNode("subagent", true)).toBe("agent");
    expect(askKindForNode("resource", false)).toBe("resource");
    expect(askKindForNode("phase", false)).toBe("group");
    expect(askKindForNode("agent", false)).toBe("step");
  });

  it("invites a question about the selection (4.1.2, 4.2.1)", () => {
    expect(askPlaceholder({ name: "acme", kind: "project", path: "/a" })).toBe(
      "Ask about this project",
    );
    expect(askPlaceholder(agent)).toBe("Ask about tenant-screening");
    expect(askChipLabel(agent)).toBe("Asking about tenant-screening · agent");
  });

  it("prepends the subject, keeping the user's words last and verbatim (Q4)", () => {
    expect(askPrompt("  What does it check?  ", agent)).toBe(
      'Context: agent "tenant-screening" at /Users/demo/property-ops/tenant-screening\n\nWhat does it check?',
    );
    expect(askPrompt("Just this", null)).toBe("Just this");
  });

  it("reads the subject back from a stored prompt", () => {
    const quoted: AskSubject = {
      name: 'Slack "#ops" feed',
      kind: "resource",
      path: "/p#node_1",
    };
    for (const subject of [agent, quoted]) {
      const question = "Line one\n\nLine two";
      expect(parseAskPrompt(askPrompt(question, subject))).toEqual({
        subject,
        question,
      });
    }
    expect(parseAskPrompt("No context here")).toEqual({
      subject: null,
      question: "No context here",
    });
    expect(parseAskPrompt('Context: agent "x" at\n\nno path')).toEqual({
      subject: null,
      question: 'Context: agent "x" at\n\nno path',
    });
  });
});
