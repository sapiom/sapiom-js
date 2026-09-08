import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createServer } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { StudioProjectCatalog } from "../core/studio-project-catalog.js";
import {
  launchComparison,
  parseComparisonArgs,
  prepareComparisonProfile,
  requireAvailablePort,
} from "./elk-preview.js";
import { runCli } from "./bin.js";
import { canStartCli, parseArgs } from "./args.js";
import { cliBrowserUrl } from "./banner.js";

vi.mock("./bin.js", () => ({ runCli: vi.fn() }));
let root = "";
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(runCli).mockReset();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "elk-launch-")),
  );
  const source = path.join(root, "desktop");
  const destination = path.join(root, "trial");
  const catalog = new StudioProjectCatalog(
    path.join(source, "studio-projects.json"),
  );
  const project = (
    await catalog.reconcile([
      { workspaceKey: "existing", cwd: path.join(root, "agents") },
    ])
  ).projects[0]!;
  const argv = [
    "--source-state-root",
    source,
    "--state-root",
    destination,
    "--project",
    project.projectId,
    "--port",
    "0",
    "--no-open",
  ];
  return {
    source,
    destination,
    project,
    argv,
    options: parseComparisonArgs(argv),
  };
}

it("reopens without resetting destination edits or initialization attempts", async () => {
  const f = await fixture();
  const manifest = await prepareComparisonProfile(f.options);
  const sharedAgentRoot = path.join(root, "agents");
  await fs.mkdir(sharedAgentRoot);
  await fs.symlink(
    f.source,
    path.join(sharedAgentRoot, "unrelated-source-link"),
  );
  const sentinel = path.join(
    f.destination,
    "agent-map",
    "projects",
    f.project.projectId,
    "initialization.json",
  );
  await fs.mkdir(path.dirname(sentinel), { recursive: true });
  await fs.writeFile(sentinel, "retained test state");
  await fs.writeFile(
    path.join(f.source, "studio-projects.json"),
    "source changed after snapshot",
  );
  expect(
    await prepareComparisonProfile(
      parseComparisonArgs(["--state-root", f.destination]),
    ),
  ).toEqual(manifest);
  expect(await fs.readFile(sentinel, "utf8")).toBe("retained test state");
  expect(await prepareComparisonProfile(f.options)).toEqual(manifest);
});

it("rejects missing, corrupt, relocated, or mismatched manifests without importing again", async () => {
  const f = await fixture();
  await prepareComparisonProfile(f.options);
  const file = path.join(f.destination, "comparison-profile.json");
  const bytes = await fs.readFile(file);
  await expect(
    prepareComparisonProfile({
      ...f.options,
      projectIds: ["project_00000000-0000-4000-8000-000000000099"],
    }),
  ).rejects.toThrow("Projects differ");
  await expect(
    prepareComparisonProfile({ ...f.options, sourceStateRoot: root }),
  ).rejects.toThrow("Source differs");
  for (const content of [
    "{",
    JSON.stringify({
      ...JSON.parse(bytes.toString()),
      destinationStateRoot: f.source,
    }),
  ]) {
    await fs.writeFile(file, content);
    await expect(prepareComparisonProfile(f.options)).rejects.toThrow(
      /manifest|comparison-profile/,
    );
    expect(await fs.readFile(file, "utf8")).toBe(content);
  }
  await fs.rm(file);
  await expect(prepareComparisonProfile(f.options)).rejects.toThrow(
    "Invalid comparison-profile",
  );
  await fs.rm(f.destination, { recursive: true });
  await fs.mkdir(f.destination);
  await expect(prepareComparisonProfile(f.options)).resolves.toMatchObject({
    published: true,
  });
});

it("rejects symlinked state before boot and does not claim an empty selection", async () => {
  const f = await fixture();
  await expect(
    prepareComparisonProfile({
      ...f.options,
      projectIds: ["project_00000000-0000-4000-8000-000000000099"],
    }),
  ).rejects.toThrow("No projects imported");
  await expect(fs.stat(f.destination)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await prepareComparisonProfile(f.options);
  const file = path.join(f.destination, "comparison-profile.json");
  await fs.rename(file, path.join(root, "manifest.json"));
  await fs.symlink(path.join(root, "manifest.json"), file);
  await expect(prepareComparisonProfile(f.options)).rejects.toThrow("symlink");
});

it("retains the normal CLI auth boundary and releases its profile claim when boot fails", async () => {
  const f = await fixture();
  vi.mocked(runCli).mockRejectedValue(new Error("boot failed"));
  await expect(launchComparison(f.argv)).rejects.toThrow("boot failed");
  expect(runCli).toHaveBeenCalledWith([
    f.destination,
    "--state-root",
    f.destination,
    "--port",
    "0",
    "--no-session",
    "--no-telemetry",
    "--map-layout",
    "elk",
    "--no-open",
  ]);
  await expect(
    fs.stat(path.join(f.destination, "comparison-profile.lock")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await fs.writeFile(
    path.join(f.destination, "comparison-profile.lock"),
    String(process.pid),
  );
  await expect(launchComparison(f.argv)).rejects.toThrow("already claimed");
  expect(runCli).toHaveBeenCalledOnce();
});

it.each([
  "events.ndjson",
  "records/session/events.ndjson",
  "generated/session/context.json",
])("rejects writable metadata links before boot: %s", async (relative) => {
  const f = await fixture();
  await prepareComparisonProfile(f.options);
  const sourceLog = path.join(f.source, "events.ndjson");
  await fs.writeFile(sourceLog, "desktop event bytes\n");
  const target = path.join(f.destination, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.symlink(sourceLog, target);
  vi.mocked(runCli).mockRejectedValue(new Error("server boot reached"));
  await expect(launchComparison(f.argv)).rejects.toThrow("symlink");
  expect(runCli).not.toHaveBeenCalled();
  expect(await fs.readFile(sourceLog, "utf8")).toBe("desktop event bytes\n");
});

it("reports a port collision without closing the existing listener", async () => {
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  try {
    const address = listener.address() as { port: number };
    await expect(requireAvailablePort(address.port)).rejects.toThrow(
      "choose another --port",
    );
    expect(listener.listening).toBe(true);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

it("validates launcher inputs and includes Vertical in the actual authorized URL", () => {
  expect(() => parseComparisonArgs([])).toThrow("--state-root");
  expect(() => parseComparisonArgs(["--state-root", "--project"])).toThrow(
    "requires a value",
  );
  expect(() =>
    parseComparisonArgs(["--state-root", "/tmp/trial", "--port", "65536"]),
  ).toThrow("--port");
  expect(() => parseArgs(["--map-layout", "invalid"])).toThrow(
    "classic or elk",
  );
  const options = parseArgs(["--no-session", "--map-layout", "elk"]);
  expect(cliBrowserUrl(4101, "boot token", options.mapLayout)).toBe(
    "http://localhost:4101/?uiToken=boot+token&mapLayout=elk",
  );
  const report = {
    ok: false,
    checks: [{ name: "node", ok: true, detail: "supported" }],
    availableHarnesses: [],
  };
  expect(canStartCli(report, options.noSession)).toBe(true);
  expect(canStartCli(report, false)).toBe(false);
  expect(
    canStartCli(
      { ...report, checks: [{ name: "node", ok: false, detail: "old" }] },
      true,
    ),
  ).toBe(false);
});
