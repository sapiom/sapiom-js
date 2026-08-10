import { describe, expect, it } from "vitest";
import { DEFAULT_EDITOR, editorLabel, editorUrl, resolveEditor } from "./editors";

describe("resolveEditor", () => {
  it("keeps a known editor and falls back for anything else", () => {
    expect(resolveEditor("cursor")).toBe("cursor");
    // Absent (a settings file older than the picker) and unknown (one newer)
    // both have to land on the default rather than build a dead scheme.
    expect(resolveEditor(undefined)).toBe(DEFAULT_EDITOR);
    expect(resolveEditor("emacs")).toBe(DEFAULT_EDITOR);
  });
});

describe("editorUrl", () => {
  it("uses the chosen editor's scheme", () => {
    expect(editorUrl("cursor", "/Users/me/agent")).toBe("cursor://file/Users/me/agent");
    expect(editorUrl("windsurf", "/Users/me/agent")).toBe("windsurf://file/Users/me/agent");
    expect(editorUrl(undefined, "/Users/me/agent")).toBe("vscode://file/Users/me/agent");
  });

  it("normalizes a Windows path to the POSIX shape the handler expects", () => {
    expect(editorUrl("cursor", "C:\\Users\\me\\agent")).toBe("cursor://file/C:/Users/me/agent");
  });

  it("escapes a path with spaces", () => {
    expect(editorUrl("zed", "/Users/me/My Agents")).toBe("zed://file/Users/me/My%20Agents");
  });
});

describe("editorLabel", () => {
  it("names the editor the menu item will open", () => {
    expect(editorLabel("cursor")).toBe("Cursor");
    expect(editorLabel(undefined)).toBe("VS Code");
  });
});
