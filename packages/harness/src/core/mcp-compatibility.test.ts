import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  bundledMcpCommand,
  mcpCommandForEntry,
  qualifyMcpCommand,
} from "./mcp-compatibility.js";

const descriptor = {
  descriptorVersion: 1,
  packageName: "@sapiom/mcp",
  packageVersion: "1.2.3",
  artifactHash: "a".repeat(64),
  hostProtocolVersions: [1],
  mapSchemaVersions: [1],
  features: ["studio-context"],
};
const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(
  source = `console.log(${JSON.stringify(JSON.stringify(descriptor))})`,
  marker: number | undefined = 1,
) {
  const root = await mkdtemp(join(tmpdir(), "mcp preflight space-"));
  temporary.push(root);
  await mkdir(join(root, "dist"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@sapiom/mcp",
      version: "1.2.3",
      type: "module",
      bin: { "sapiom-mcp": "dist/index.js" },
      sapiomCapabilities: marker,
    }),
  );
  const entry = join(root, "dist/index.js");
  await writeFile(entry, source);
  return { root, entry, command: mcpCommandForEntry(entry) };
}

it("qualifies the exact executable without passing credentials or inherited preload hooks", async () => {
  vi.stubEnv("SAPIOM_STUDIO_HOST_CONTEXT", "private-context");
  vi.stubEnv("SAPIOM_API_KEY", "secret");
  vi.stubEnv("NODE_OPTIONS", "--require=/must-not-load");
  vi.stubEnv("ESBUILD_BINARY_PATH", "/private/pin");
  const f = await fixture(`
    if (process.argv.at(-1) !== '--describe-capabilities') process.exit(2);
    if (Object.keys(process.env).some(k => /SAPIOM_|HARNESS_|NODE_OPTIONS|ESBUILD/.test(k))) process.exit(3);
    console.log(${JSON.stringify(JSON.stringify(descriptor))});
  `);
  expect(await qualifyMcpCommand(f.command)).toEqual({
    kind: "verified",
    launch: f.command,
    descriptor,
  });
});

it("does not execute an unmarked legacy package", async () => {
  const f = await fixture("throw new Error('must never run');", undefined);
  // Explicitly delete the marker: default arguments otherwise select version 1.
  const pkg = JSON.parse(await readFile(join(f.root, "package.json"), "utf8"));
  delete pkg.sapiomCapabilities;
  await writeFile(join(f.root, "package.json"), JSON.stringify(pkg));
  expect(await qualifyMcpCommand(f.command)).toEqual({
    kind: "legacy",
    launch: f.command,
  });
});

it.each([
  "process.exit(2)",
  "console.log('not json')",
  "console.log('{}')",
  "console.log('x'.repeat(17000))",
  "console.error('private failure')",
  "setInterval(() => {}, 1000)",
])("bounds a marked but broken probe: %s", async (source) => {
  const f = await fixture(source);
  const result = await qualifyMcpCommand(f.command, 150);
  expect(result.kind).toBe("unavailable");
  expect(JSON.stringify(result)).not.toContain("private failure");
});

it("kills the direct probe process on timeout", async () => {
  const f = await fixture(`import { writeFileSync } from 'node:fs';
    writeFileSync(new URL('../pid', import.meta.url), String(process.pid)); setInterval(() => {}, 1000);`);
  expect((await qualifyMcpCommand(f.command, 300)).kind).toBe("unavailable");
  const pid = Number(await readFile(join(f.root, "pid"), "utf8"));
  await vi.waitFor(async () => {
    if (process.platform === "linux") {
      const status = await readFile(`/proc/${pid}/status`, "utf8").catch(
        () => "State:\tZ",
      );
      expect(status).toMatch(/State:\s+Z/);
    } else expect(() => process.kill(pid, 0)).toThrow();
  });
});

it("rejects an executable that changes during its probe", async () => {
  const f = await fixture(`import { appendFileSync } from 'node:fs';
    appendFileSync(new URL(import.meta.url), '\\n// replaced'); console.log(${JSON.stringify(JSON.stringify(descriptor))});`);
  expect(await qualifyMcpCommand(f.command)).toMatchObject({
    kind: "unavailable",
    reason: "changed",
  });
});

it("reports missing artifacts and refuses arbitrary command arguments", async () => {
  const f = await fixture();
  expect(
    (
      await qualifyMcpCommand({
        ...f.command,
        command: join(f.root, "missing-node"),
      })
    ).kind,
  ).toBe("unavailable");
  expect(
    (await qualifyMcpCommand({ ...f.command, args: ["-e", "process.exit()"] }))
      .kind,
  ).toBe("unavailable");
  await rm(f.entry);
  expect(await qualifyMcpCommand(f.command)).toMatchObject({
    kind: "unavailable",
    reason: "missing",
  });
});

it("does not infer support from a new package version", async () => {
  const f = await fixture(
    `console.log(${JSON.stringify(JSON.stringify({ ...descriptor, hostProtocolVersions: [2] }))})`,
  );
  expect((await qualifyMcpCommand(f.command)).kind).toBe("legacy");
});

it("preserves interpreter and Windows argument boundaries while unpacking asar paths", () => {
  expect(
    mcpCommandForEntry(
      "C:\\App Space\\app.asar\\node_modules\\@sapiom\\mcp\\dist\\index.js",
      "C:\\App Space\\Studio.exe",
      true,
    ),
  ).toEqual({
    command: "C:\\App Space\\Studio.exe",
    args: [
      "C:\\App Space\\app.asar.unpacked\\node_modules\\@sapiom\\mcp\\dist\\index.js",
    ],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
  expect(bundledMcpCommand()?.args[0]).toMatch(/mcp[/\\]dist[/\\]index\.js$/);
});

it.each(["running", "exited", "success"])(
  "reaps probe descendants (parent: %s)",
  async (mode) => {
    const f =
      await fixture(`import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:${mode === "success" ? "'ignore'" : "['ignore',1,2]"}});
    writeFileSync(new URL('../child-pid', import.meta.url), String(child.pid));
    ${mode === "success" ? `console.log(${JSON.stringify(JSON.stringify(descriptor))})` : ""};
    ${mode === "running" ? "setInterval(() => {}, 1000)" : "process.exit(0)"};`);
    let pid: number | undefined;
    try {
      const result = await Promise.race([
        qualifyMcpCommand(f.command, 400),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("preflight exceeded deadline")),
            2_000,
          ),
        ),
      ]);
      expect(result.kind).toBe(mode === "success" ? "verified" : "unavailable");
      pid = Number(await readFile(join(f.root, "child-pid"), "utf8"));
      await vi.waitFor(
        async () => {
          if (process.platform === "linux") {
            const status = await readFile(`/proc/${pid}/status`, "utf8").catch(
              () => "State:\tZ",
            );
            expect(status).toMatch(/State:\s+Z/);
          } else expect(() => process.kill(pid!, 0)).toThrow();
        },
        { timeout: 1_000 },
      );
    } finally {
      pid ??= Number(
        await readFile(join(f.root, "child-pid"), "utf8").catch(() => "0"),
      );
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
    }
  },
);
