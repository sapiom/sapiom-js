import { describe, expect, it } from "vitest";
import type { WorkflowInfo } from "@shared/types";

import { mergeProjectAppLinks } from "./project-app-links";

const agent = (name: string, path = `/p/${name}`): WorkflowInfo => ({
  name,
  path,
  definitionId: 1,
  definitionSlug: name,
  source: "scan",
});

describe("mergeProjectAppLinks", () => {
  it("lists deployed links first, then local ones by port", () => {
    const links = mergeProjectAppLinks(
      [{ agent: agent("leasing"), url: "https://leasing.apps.sapiom.ai" }],
      [
        { port: 5180, url: "http://localhost:5180/" },
        { port: 5174, url: "http://localhost:5174/" },
      ],
    );
    expect(links.map((link) => link.id)).toEqual([
      "agent-leasing",
      "local-5174",
      "local-5180",
    ]);
    expect(links[0]).toMatchObject({ label: "leasing", deployed: true, host: null });
    expect(links[1]).toMatchObject({
      label: "Dev server",
      deployed: false,
      host: "localhost:5174",
      url: "http://localhost:5174/",
    });
  });

  it("lists a port once, however many sessions announced it", () => {
    const links = mergeProjectAppLinks(
      [],
      [
        { port: 5174, url: "http://localhost:5174/" },
        { port: 5174, url: "http://localhost:5174/" },
      ],
    );
    expect(links.map((link) => link.id)).toEqual(["local-5174"]);
  });

  it("drops a local link whose URL a deployed link already names", () => {
    const links = mergeProjectAppLinks(
      [{ agent: agent("board"), url: "http://localhost:5174" }],
      [{ port: 5174, url: "http://localhost:5174/" }],
    );
    expect(links.map((link) => link.id)).toEqual(["agent-board"]);
  });

  it("gives two agents that share a name distinct ids", () => {
    const links = mergeProjectAppLinks(
      [
        { agent: agent("portal", "/p/first/portal"), url: "https://a.apps.sapiom.ai" },
        { agent: agent("portal", "/p/second/portal"), url: "https://b.apps.sapiom.ai" },
      ],
      [],
    );
    expect(links.map((link) => link.id)).toEqual(["agent-portal", "agent-portal-2"]);
  });

  it("is empty with nothing deployed and nothing running", () => {
    expect(mergeProjectAppLinks([], [])).toEqual([]);
  });
});
