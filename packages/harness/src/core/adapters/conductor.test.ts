/**
 * Conductor adapter: external/companion mode with deterministic app-bundle
 * candidate paths and no spawn surface.
 */
import { describe, expect, it } from "vitest";
import { conductorAdapterInfo, conductorAppCandidates } from "./conductor.js";

describe("conductorAdapterInfo", () => {
  it("is external and offers no launch command", () => {
    expect(conductorAdapterInfo.id).toBe("conductor");
    expect(conductorAdapterInfo.label).toBe("Conductor");
    expect(conductorAdapterInfo.mode).toBe("external");
    expect("launchCommand" in conductorAdapterInfo).toBe(false);
  });

  it("is not experimental", () => {
    expect(conductorAdapterInfo.experimental).toBeFalsy();
  });

  it("guides MCP setup through Claude Code project scope", () => {
    const prompt = conductorAdapterInfo.installMcpPrompt();
    expect(prompt).toContain("claude mcp add --scope project sapiom-dev -- npx -y @sapiom/mcp");
    expect(prompt).toContain(".mcp.json");
    expect(prompt).toContain("@sapiom/mcp");
  });

  it("detectInstalled resolves to a boolean without throwing", async () => {
    await expect(conductorAdapterInfo.detectInstalled()).resolves.toEqual(expect.any(Boolean));
  });
});

describe("conductorAppCandidates", () => {
  it("returns the standard macOS app locations on darwin", () => {
    expect(conductorAppCandidates("darwin", "/Users/someone")).toEqual([
      "/Applications/Conductor.app",
      "/Users/someone/Applications/Conductor.app",
    ]);
  });

  it("returns no candidates on platforms Conductor does not ship for", () => {
    expect(conductorAppCandidates("linux", "/home/someone")).toEqual([]);
    expect(conductorAppCandidates("win32", "C:\\Users\\someone")).toEqual([]);
  });
});
