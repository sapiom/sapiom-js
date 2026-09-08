import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

try {
  if (process.argv.includes("--help")) {
    console.log(
      "pnpm studio:elk-preview --state-root <trial> [--source-state-root <desktop> --project <id> ...] [--port 4101] [--no-open]\nFirst import requires a source and projects. Reopen with the same trial directory; a new snapshot requires a new directory.",
    );
  } else {
    const pnpm = process.env.npm_execpath;
    if (
      Number(process.versions.node.split(".")[0]) < 20 ||
      !pnpm ||
      Number(
        execFileSync(process.execPath, [pnpm, "--version"], {
          encoding: "utf8",
        })
          .trim()
          .split(".")[0],
      ) < 10
    )
      throw new Error(
        "Run with Node >= 20 and pnpm >= 10 after pnpm install --frozen-lockfile.",
      );
    const cwd = fileURLToPath(new URL("../../..", import.meta.url));
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
    }).trim();
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
    }).trim();
    console.log(
      `Building Agent Studio: ${branch || "detached"} @ ${commit}${dirty ? " (uncommitted changes)" : ""}`,
    );
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [pnpm, "--filter", "@sapiom/harness...", "build"],
        {
          cwd,
          stdio: "inherit",
          env: { ...process.env, VITE_MOCK: "0" },
        },
      );
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0
          ? resolve()
          : reject(new Error(`Studio build failed (${signal ?? code}).`)),
      );
    });
    const { launchComparison } = await import("../dist/cli/elk-preview.js");
    await launchComparison(process.argv.slice(2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
