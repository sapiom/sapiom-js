/**
 * The external conductor adapter: guidance-only companion mode with
 * deterministic app-bundle candidate paths and no spawn surface.
 */
import { conductorAdapter, conductorAppCandidates } from "../conductor.js";

describe("conductorAdapter", () => {
  it("is external and offers no launch command", () => {
    expect(conductorAdapter.id).toBe("conductor");
    expect(conductorAdapter.label).toBe("Conductor");
    expect(conductorAdapter.mode).toBe("external");
    expect("launchCommand" in conductorAdapter).toBe(false);
    expect(conductorAdapter.launchCommand).toBeUndefined();
  });

  it("guides MCP setup through Claude Code project scope", () => {
    const prompt = conductorAdapter.installMcpPrompt();
    expect(prompt).toContain(
      "claude mcp add --scope project sapiom-dev -- npx -y @sapiom/mcp",
    );
    expect(prompt).toContain(".mcp.json");
  });

  it("detectInstalled resolves to a boolean without throwing", async () => {
    // The concrete value depends on whether this machine has the app.
    await expect(conductorAdapter.detectInstalled()).resolves.toEqual(
      expect.any(Boolean),
    );
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
