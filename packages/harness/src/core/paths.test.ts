import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

const FAKE_HOME = "/fake-home";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => FAKE_HOME };
});

import { expandHome, resolveStatePaths } from "./paths.js";

describe("expandHome", () => {
  it("expands ~ and ~/ against the home dir and resolves everything else", () => {
    expect(expandHome("~")).toBe(FAKE_HOME);
    expect(expandHome("~/x/y")).toBe(path.join(FAKE_HOME, "x", "y"));
    expect(expandHome("/abs/path")).toBe("/abs/path");
  });
});

describe("resolveStatePaths", () => {
  it("defaults to the real harness home", () => {
    const paths = resolveStatePaths();
    const root = path.join(FAKE_HOME, ".sapiom", "harness");
    expect(paths.root).toBe(root);
    expect(paths.machineId).toBe(path.join(root, "machine-id"));
    expect(paths.sessions).toBe(path.join(root, "sessions.json"));
    expect(paths.workflows).toBe(path.join(root, "workflows.json"));
    expect(paths.workspaces).toBe(path.join(root, "workspaces.json"));
    expect(paths.events).toBe(path.join(root, "events.ndjson"));
    expect(paths.settings).toBe(path.join(root, "settings.json"));
    expect(paths.generated).toBe(path.join(root, "generated"));
    expect(paths.sampleProject).toBe(path.join(root, "sample-project"));
  });

  it("roots every path under a given stateRoot", () => {
    const paths = resolveStatePaths("/scratch/state");
    expect(paths.root).toBe("/scratch/state");
    expect(paths.machineId).toBe("/scratch/state/machine-id");
    expect(paths.sessions).toBe("/scratch/state/sessions.json");
    expect(paths.workflows).toBe("/scratch/state/workflows.json");
    expect(paths.workspaces).toBe("/scratch/state/workspaces.json");
    expect(paths.events).toBe("/scratch/state/events.ndjson");
    expect(paths.settings).toBe("/scratch/state/settings.json");
    expect(paths.generated).toBe("/scratch/state/generated");
    expect(paths.sampleProject).toBe("/scratch/state/sample-project");
  });

  it("expands a ~-prefixed stateRoot", () => {
    expect(resolveStatePaths("~/elsewhere").root).toBe(path.join(FAKE_HOME, "elsewhere"));
  });
});
