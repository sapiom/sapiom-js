import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  AgentStudioLaunchError,
  launchAgentStudio,
  resolveHarnessBin,
  signalExitCode,
} from "../lib/launcher.mjs";

const packageJsonPath = path.resolve(
  "install/node_modules/@sapiom/harness/package.json",
);
const harnessBinPath = path.resolve(
  "install/node_modules/@sapiom/harness/dist/cli/bin.js",
);

function resolver(overrides = {}) {
  return {
    resolvePackageJson: () => packageJsonPath,
    readFile: () =>
      JSON.stringify({ bin: { "sapiom-harness": "./dist/cli/bin.js" } }),
    fileExists: () => true,
    ...overrides,
  };
}

class FakeChild extends EventEmitter {
  killSignals = [];

  kill(signal) {
    this.killSignals.push(signal);
    return true;
  }
}

class FakeProcess extends EventEmitter {
  exitCode = undefined;
}

test("package exposes one branded bin and an exact workspace dependency", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );

  assert.equal(manifest.name, "@sapiom/agent-studio");
  assert.deepEqual(manifest.bin, {
    "agent-studio": "./bin/agent-studio.mjs",
  });
  assert.equal(manifest.dependencies["@sapiom/harness"], "workspace:*");
  assert.equal(manifest.engines.node, ">=20.0.0");
  assert.deepEqual(manifest.files, [
    "bin",
    "lib",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
  ]);
});

test("resolves the sapiom-harness bin from its manifest", () => {
  assert.equal(resolveHarnessBin(resolver()), harnessBinPath);
});

test("reports an actionable error when Harness cannot be resolved", () => {
  assert.throws(
    () =>
      resolveHarnessBin(
        resolver({
          resolvePackageJson: () => {
            throw Object.assign(new Error("missing"), {
              code: "MODULE_NOT_FOUND",
            });
          },
        }),
      ),
    (error) => {
      assert.ok(error instanceof AgentStudioLaunchError);
      assert.equal(error.code, "HARNESS_NOT_INSTALLED");
      assert.match(error.hint, /@sapiom\/agent-studio@latest/);
      return true;
    },
  );
});

test("rejects an unreadable or malformed Harness manifest", () => {
  assert.throws(
    () => resolveHarnessBin(resolver({ readFile: () => "not json" })),
    (error) => {
      assert.ok(error instanceof AgentStudioLaunchError);
      assert.equal(error.code, "HARNESS_MANIFEST_INVALID");
      return true;
    },
  );
});

test("rejects a manifest without the sapiom-harness bin", () => {
  assert.throws(
    () =>
      resolveHarnessBin(
        resolver({ readFile: () => JSON.stringify({ bin: {} }) }),
      ),
    (error) => {
      assert.ok(error instanceof AgentStudioLaunchError);
      assert.equal(error.code, "HARNESS_BIN_NOT_FOUND");
      assert.match(error.message, /no sapiom-harness bin entry/);
      return true;
    },
  );
});

test("rejects a manifest whose bin target is absent", () => {
  assert.throws(
    () => resolveHarnessBin(resolver({ fileExists: () => false })),
    (error) => {
      assert.ok(error instanceof AgentStudioLaunchError);
      assert.equal(error.code, "HARNESS_BIN_NOT_FOUND");
      assert.match(error.message, /was not found/);
      return true;
    },
  );
});

test("forwards arguments, cwd, environment, and stdio unchanged", async () => {
  const child = new FakeChild();
  const processRef = new FakeProcess();
  const argv = ["/workspace/with spaces", "--port", "4200", "--no-open"];
  const env = { PATH: "/custom/bin", SAPIOM_TEST: "1" };
  let spawnCall;

  const launched = launchAgentStudio({
    argv,
    cwd: "/caller/cwd",
    env,
    execPath: "/custom/node",
    processRef,
    resolver: resolver(),
    spawn: (...args) => {
      spawnCall = args;
      return child;
    },
  });

  child.emit("close", 0, null);
  await launched;

  assert.deepEqual(spawnCall, [
    "/custom/node",
    [harnessBinPath, ...argv],
    { cwd: "/caller/cwd", env, stdio: "inherit" },
  ]);
  assert.equal(processRef.exitCode, undefined);
});

test("forwards SIGTERM and SIGHUP but does not install a SIGINT handler", async () => {
  const child = new FakeChild();
  const processRef = new FakeProcess();
  const launched = launchAgentStudio({
    processRef,
    resolver: resolver(),
    spawn: () => child,
  });

  assert.equal(processRef.listenerCount("SIGINT"), 0);
  processRef.emit("SIGTERM");
  processRef.emit("SIGHUP");
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGHUP"]);

  child.emit("close", 0, null);
  await launched;
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
  assert.equal(processRef.listenerCount("SIGHUP"), 0);
});

test("propagates a nonzero child exit code", async () => {
  const child = new FakeChild();
  const processRef = new FakeProcess();
  const launched = launchAgentStudio({
    processRef,
    resolver: resolver(),
    spawn: () => child,
  });

  child.emit("close", 23, null);
  await launched;
  assert.equal(processRef.exitCode, 23);
});

test("maps child signal termination to the conventional exit code", async () => {
  const child = new FakeChild();
  const processRef = new FakeProcess();
  const launched = launchAgentStudio({
    processRef,
    resolver: resolver(),
    spawn: () => child,
  });

  child.emit("close", null, "SIGTERM");
  await launched;
  assert.equal(processRef.exitCode, 143);
  assert.equal(signalExitCode("SIGINT"), 130);
});

test("reports asynchronous child-process launch failures", async () => {
  const child = new FakeChild();
  const processRef = new FakeProcess();
  const launched = launchAgentStudio({
    processRef,
    resolver: resolver(),
    spawn: () => child,
  });

  child.emit("error", new Error("spawn failed"));
  await assert.rejects(launched, (error) => {
    assert.ok(error instanceof AgentStudioLaunchError);
    assert.equal(error.code, "HARNESS_SPAWN_FAILED");
    assert.match(error.message, /spawn failed/);
    return true;
  });
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
  assert.equal(processRef.listenerCount("SIGHUP"), 0);
});

test("reports synchronous child-process launch failures", async () => {
  await assert.rejects(
    launchAgentStudio({
      resolver: resolver(),
      spawn: () => {
        throw new Error("spawn threw");
      },
    }),
    (error) => {
      assert.ok(error instanceof AgentStudioLaunchError);
      assert.equal(error.code, "HARNESS_SPAWN_FAILED");
      assert.match(error.message, /spawn threw/);
      return true;
    },
  );
});
