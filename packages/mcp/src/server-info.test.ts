import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("./version.js", () => ({ packageVersion: () => "9.9.9" }));

import { createServerInfo } from "./server-info.js";
import { RUN_LOCAL_TOOL_DESCRIPTION } from "./tools/agents.js";

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { description: string };
const registryMetadata = JSON.parse(
  readFileSync(new URL("../server.json", import.meta.url), "utf8"),
) as { description: string };

describe("createServerInfo", () => {
  it("reports the package version and the local/cloud boundary", () => {
    const info = createServerInfo();

    expect(info.version).toBe("9.9.9");
    expect(info.description).toContain("tests agents locally");
    expect(info.description).toContain("authenticated cloud actions");
    expect(info.description).toContain("Sapiom Cloud MCP");
    expect(info.description).not.toContain("unmetered");
    expect(info.description).not.toContain("makes no paid capability calls");
  });

  it("keeps every published metadata surface on the authenticated-cloud boundary", () => {
    for (const description of [
      packageMetadata.description,
      registryMetadata.description,
    ]) {
      expect(description).toContain("authenticated cloud actions");
      expect(description).toContain("Sapiom Cloud MCP");
      expect(description).not.toContain("unmetered");
      expect(description).not.toContain("makes no paid capability calls");
    }
  });

  it("states the exact Local Run side-effect boundary in tool discovery", () => {
    expect(RUN_LOCAL_TOOL_DESCRIPTION).toContain(
      "no Sapiom capability request or spend",
    );
    expect(RUN_LOCAL_TOOL_DESCRIPTION).toContain(
      "file, process, and network side effects still run",
    );
    expect(RUN_LOCAL_TOOL_DESCRIPTION).not.toMatch(
      /no cost|instant|entirely offline/i,
    );
  });
});
