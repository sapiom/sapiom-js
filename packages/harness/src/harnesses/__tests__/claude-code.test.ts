/**
 * Launch-config correctness for the fully supported claude-code adapter:
 * plain interactive launch, literal argv for the appended system prompt
 * (no shell, no escaping), environment pass-through by copy.
 */
import { claudeCodeAdapter } from "../claude-code.js";

describe("claudeCodeAdapter", () => {
  it("identifies as the embedded claude-code harness with post-launch prompts", () => {
    expect(claudeCodeAdapter.id).toBe("claude-code");
    expect(claudeCodeAdapter.label).toBe("Claude Code");
    expect(claudeCodeAdapter.mode).toBe("embedded");
    expect(claudeCodeAdapter.promptDelivery).toBe("post-launch");
    expect(claudeCodeAdapter.experimental).toBeFalsy();
  });

  it("launches plain interactive claude by default", () => {
    const launch = claudeCodeAdapter.launchCommand({
      env: { PATH: "/usr/bin", TERM: "xterm-256color" },
    });

    expect(launch).toEqual({
      command: "claude",
      args: [],
      env: { PATH: "/usr/bin", TERM: "xterm-256color" },
    });
  });

  it("copies the environment instead of aliasing the caller's object", () => {
    const env = { PATH: "/usr/bin" };
    const launch = claudeCodeAdapter.launchCommand({ env });

    expect(launch.env).toEqual(env);
    expect(launch.env).not.toBe(env);

    launch.env.MUTATED = "yes";
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("passes the appended system prompt as one literal argv pair", () => {
    const content =
      "Line one\nLine two with \"double\", 'single', $HOME, `backticks`," +
      " $(subshells), ; & | and a trailing backslash \\";
    const launch = claudeCodeAdapter.launchCommand({
      env: {},
      appendSystemPrompt: content,
    });

    // Exactly two args: the flag and the untouched content. No shell ever
    // sees these, so no quoting/escaping may be applied.
    expect(launch.args).toEqual(["--append-system-prompt", content]);
  });

  it("passes an empty system prompt literally too", () => {
    const launch = claudeCodeAdapter.launchCommand({
      env: {},
      appendSystemPrompt: "",
    });
    expect(launch.args).toEqual(["--append-system-prompt", ""]);
  });

  it("omits the flag when no system prompt is configured", () => {
    const launch = claudeCodeAdapter.launchCommand({ env: {} });
    expect(launch.args).toEqual([]);
  });

  it("ignores inline prompts — delivery is post-launch via session write", () => {
    const launch = claudeCodeAdapter.launchCommand({
      env: {},
      prompt: "do the thing",
    });
    expect(launch.args).toEqual([]);
    expect(launch.command).toBe("claude");
  });

  it("install prompt teaches claude mcp add for @sapiom/mcp", () => {
    const prompt = claudeCodeAdapter.installMcpPrompt();
    expect(prompt).toContain("claude mcp add sapiom-dev -- npx -y @sapiom/mcp");
    expect(prompt).toContain("sapiom-mcp");
    expect(prompt).toContain("claude mcp list");
  });
});
