const fs = require("node:fs");

function environmentCapturePath(base, sessionId) {
  return `${base}.${encodeURIComponent(sessionId)}.json`;
}

function captureAgentEnvironment(env = process.env) {
  const base = env.SAPIOM_SMOKE_AGENT_ENV;
  const sessionId = env.SAPIOM_HARNESS_SESSION_ID;
  if (!base || !sessionId) return null;

  const file = environmentCapturePath(base, sessionId);
  const snapshot = {
    schemaVersion: 1,
    sessionId,
    variableCount: Object.keys(env).length,
    hasEsbuildBinaryPath: Object.prototype.hasOwnProperty.call(
      env,
      "ESBUILD_BINARY_PATH",
    ),
    hasPath: typeof env.PATH === "string" && env.PATH.length > 0,
  };
  fs.writeFileSync(file, `${JSON.stringify(snapshot)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return file;
}

function runSessionStartHook() {
  try {
    const settingsIndex = process.argv.indexOf("--settings");
    const settingsPath =
      settingsIndex > -1 ? process.argv[settingsIndex + 1] : null;
    if (!settingsPath) return;
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const command = settings.hooks.SessionStart[0].hooks[0].command;
    const { execFileSync, execSync } = require("node:child_process");
    if (process.platform === "win32") {
      const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
      if (fs.existsSync(bash)) {
        execFileSync(bash, ["-c", command], { stdio: "ignore" });
      } else {
        execSync(command, { stdio: "ignore" });
      }
    } else {
      execFileSync("/bin/sh", ["-c", command], { stdio: "ignore" });
    }
  } catch {
    // A failed hook is exactly what checkSessionCreate's ready poll reports.
  }
}

module.exports = { captureAgentEnvironment, environmentCapturePath };

if (require.main === module) {
  captureAgentEnvironment();
  runSessionStartHook();
  setTimeout(() => process.exit(0), 3000);
}
