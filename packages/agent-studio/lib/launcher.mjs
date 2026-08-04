import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const requireFromLauncher = createRequire(import.meta.url);

export class AgentStudioLaunchError extends Error {
  constructor({ code, message, hint, cause }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AgentStudioLaunchError";
    this.code = code;
    this.hint = hint;
  }
}

function defaultResolvePackageJson() {
  return requireFromLauncher.resolve("@sapiom/harness/package.json");
}

/** Resolve the implementation bin without importing or duplicating Harness. */
export function resolveHarnessBin({
  resolvePackageJson = defaultResolvePackageJson,
  readFile = readFileSync,
  fileExists = existsSync,
} = {}) {
  let packageJsonPath;
  try {
    packageJsonPath = resolvePackageJson();
  } catch (cause) {
    throw new AgentStudioLaunchError({
      code: "HARNESS_NOT_INSTALLED",
      message:
        "The @sapiom/harness implementation package could not be resolved.",
      hint: "Reinstall with: npx --yes @sapiom/agent-studio@latest",
      cause,
    });
  }

  let manifest;
  try {
    manifest = JSON.parse(readFile(packageJsonPath, "utf8"));
  } catch (cause) {
    throw new AgentStudioLaunchError({
      code: "HARNESS_MANIFEST_INVALID",
      message: "The @sapiom/harness package manifest could not be read.",
      hint: "Reinstall with: npx --yes @sapiom/agent-studio@latest",
      cause,
    });
  }

  const binEntry = manifest?.bin?.["sapiom-harness"];
  if (typeof binEntry !== "string" || binEntry.length === 0) {
    throw new AgentStudioLaunchError({
      code: "HARNESS_BIN_NOT_FOUND",
      message: "The @sapiom/harness manifest has no sapiom-harness bin entry.",
      hint: "Reinstall with: npx --yes @sapiom/agent-studio@latest",
    });
  }

  const binPath = path.resolve(path.dirname(packageJsonPath), binEntry);
  if (!fileExists(binPath)) {
    throw new AgentStudioLaunchError({
      code: "HARNESS_BIN_NOT_FOUND",
      message: `The sapiom-harness bin was not found at ${binPath}.`,
      hint: "Reinstall with: npx --yes @sapiom/agent-studio@latest",
    });
  }

  return binPath;
}

/** Convert child signal termination to the shell's conventional exit status. */
export function signalExitCode(signal) {
  const numbers = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return 128 + (numbers[signal] ?? 0);
}

/**
 * Launch Harness as an inherited child process.
 *
 * SIGINT is deliberately not forwarded: an interactive terminal delivers
 * Ctrl-C to both processes in the foreground group, so forwarding it would
 * signal Harness twice. SIGTERM and SIGHUP do need explicit forwarding.
 */
export async function launchAgentStudio({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  execPath = process.execPath,
  processRef = process,
  spawn = nodeSpawn,
  resolver,
} = {}) {
  const harnessBin = resolveHarnessBin(resolver);

  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(execPath, [harnessBin, ...argv], {
        cwd,
        env,
        stdio: "inherit",
      });
    } catch (cause) {
      reject(
        new AgentStudioLaunchError({
          code: "HARNESS_SPAWN_FAILED",
          message: `Could not start sapiom-harness: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
      );
      return;
    }

    let settled = false;
    const forwardSigterm = () => child.kill("SIGTERM");
    const forwardSighup = () => child.kill("SIGHUP");
    const cleanup = () => {
      processRef.off("SIGTERM", forwardSigterm);
      processRef.off("SIGHUP", forwardSighup);
    };

    processRef.on("SIGTERM", forwardSigterm);
    processRef.on("SIGHUP", forwardSighup);

    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new AgentStudioLaunchError({
          code: "HARNESS_SPAWN_FAILED",
          message: `Could not start sapiom-harness: ${cause.message}`,
          cause,
        }),
      );
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal) {
        processRef.exitCode = signalExitCode(signal);
      } else if (code !== null && code !== 0) {
        processRef.exitCode = code;
      }
      resolve();
    });
  });
}
