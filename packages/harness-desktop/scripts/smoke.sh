#!/usr/bin/env bash
#
# Launch the PACKAGED app's --smoke checks against an isolated state root.
# Used by two workflows (the PR test job and the release build) and usable
# locally after `pnpm --filter @sapiom/harness-desktop dist`:
#
#   packages/harness-desktop/scripts/smoke.sh
#
# Exits with the app's own exit code, after printing its report.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rel="${SMOKE_RELEASE_DIR:-$here/../release}"

smoke_home="$(mktemp -d)"
mkdir -p "$smoke_home/project" "$smoke_home/AppData"

# The app is a NATIVE process, so every path handed to it must be native too.
# git-bash's mktemp returns a POSIX path (/tmp/tmp.XXXX) with no drive letter, and
# Windows cannot use it: exporting that as APPDATA made Electron fail while
# creating its userData directory — before logging existed — which is the "exit 3
# with no output on any channel" we spent several CI rounds chasing. It was this
# script breaking the app, not the app. `cygpath -w` converts; a no-op elsewhere.
native() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) cygpath -w "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}
app_home="$(native "$smoke_home")"

# Relocate the home dir so a local run cannot touch the developer's ~/.sapiom,
# which is shared with the npx CLI. HOME covers POSIX; USERPROFILE and APPDATA
# cover Windows (os.homedir and Electron's userData read those).
#
# NOT on CI, and that is the point: a runner is an ephemeral VM destroyed minutes
# later, so there is nothing to protect — while relocating %USERPROFILE% there
# BREAKS the app. Chromium derives its profile, cache and crash-handler paths from
# it, and a bare temp dir has no AppData\Local subtree, so it aborts before
# Electron initialises logging: an exit code and total silence on every channel.
# An env bisect pinned it to this exact assignment after several wrong theories
# (asar, then the ESM entry, then APPDATA's path format).
if [ -z "${CI:-}" ]; then
  # A Windows developer needs the real profile shape, not just the directory.
  mkdir -p "$smoke_home/AppData/Roaming" "$smoke_home/AppData/Local"
  export HOME="$app_home" USERPROFILE="$app_home" APPDATA="$(native "$smoke_home/AppData/Roaming")"
  # HOME is NOT enough on Linux: Electron derives `userData` from XDG_CONFIG_HOME
  # when it is set, so relocating only HOME left every local smoke run writing to
  # the developer's real ~/.config/@sapiom/… — installing packages and app state
  # into the very profile these lines exist to protect. Found while verifying the
  # sapiom-CLI install: the app reported success and the files were nowhere near
  # the temp HOME.
  mkdir -p "$smoke_home/.config"
  export XDG_CONFIG_HOME="$(native "$smoke_home/.config")"
else
  echo "[smoke] CI detected — leaving HOME/USERPROFILE/APPDATA alone (ephemeral runner)"
fi
export SAPIOM_LAUNCH_DIR="$(native "$smoke_home/project")"
# Two forms of the report path: the app writes to the native one, this script
# reads the POSIX one.
report_file="$smoke_home/smoke.txt"
export SAPIOM_SMOKE_OUT="$(native "$report_file")"

# A stand-in for the coding agent, so the smoke run can create a REAL session
# (POST /api/sessions → pty spawn) on a machine with no agent installed. It is
# deliberately a SCRIPT, not an .exe: npm installs `claude.cmd` on Windows, and
# spawning that is what failed there — CreateProcess does no PATHEXT lookup and
# cannot execute a .cmd. A stub that was an .exe would pass while the real thing
# broke. It just idles briefly so the session is genuinely running.
# Both stubs also RUN the SessionStart hook command from their own --settings
# file, exactly the way Claude Code would (Git Bash on Windows — Claude's
# documented hook shell there, falling back to cmd when bash is absent — and
# /bin/sh -c on POSIX). The hook POSTs to /ingest with the env the stub
# inherited, which is what flips the session to `ready` — so the session-create
# check can assert the WHOLE readiness chain (settings → hook command → node
# resolution under the hook shell → POST → ready), the exact seam that broke
# silently on Windows and dropped every held first prompt.
cat > "$smoke_home/stub-agent.js" <<'STUBJS'
const fs = require("fs");
const envFile = process.env.SAPIOM_SMOKE_AGENT_ENV;
if (envFile) fs.writeFileSync(envFile, Object.entries(process.env).map(([k, v]) => k + "=" + v).join("\n") + "\n");
try {
  const i = process.argv.indexOf("--settings");
  const settingsPath = i > -1 ? process.argv[i + 1] : null;
  if (settingsPath) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const command = settings.hooks.SessionStart[0].hooks[0].command;
    const { execFileSync, execSync } = require("child_process");
    if (process.platform === "win32") {
      const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
      if (fs.existsSync(bash)) execFileSync(bash, ["-c", command], { stdio: "ignore" });
      else execSync(command, { stdio: "ignore" });
    } else {
      execFileSync("/bin/sh", ["-c", command], { stdio: "ignore" });
    }
  }
} catch {
  // A failed hook is exactly what the ready-poll in checkSessionCreate reports.
}
setTimeout(() => process.exit(0), 3000);
STUBJS
if [ "$(uname -s)" != "Linux" ] && [ "$(uname -s)" != "Darwin" ]; then
  # Shaped like an npm shim on purpose — a `.cmd` that runs `node <script>` — because
  # that is exactly what `claude.cmd` is, and it's the shape resolveSpawnTarget has
  # to see through. A stub that were a plain .cmd (or an .exe) would exercise a path
  # real agents never take, and is now correctly refused rather than shelled out.
  stub="$smoke_home/stub-agent.cmd"
  printf '@echo off\r\n"%%dp0%%\\node.exe" "%%dp0%%\\stub-agent.js" %%*\r\n' > "$stub"
else
  # `node` rather than a hardcoded path: the app's PATH augmentation (runtime
  # shims) must make it resolvable — that resolution is part of what's under test.
  stub="$smoke_home/stub-agent.sh"
  printf '#!/bin/sh\nexec node "%s" "$@"\n' "$smoke_home/stub-agent.js" > "$stub"
  chmod +x "$stub"
fi
# Where the stub agent writes its environment, so a check can assert on what the
# AGENT actually inherited rather than on what the main process meant to pass.
# This caught a real regression: the desktop host pins ESBUILD_BINARY_PATH so its
# own bundler can exec a binary outside app.asar, and the whole parent env is
# copied into the pty — so every agent, and every tool it ran in the user's repo,
# inherited a pin to OUR esbuild build ("Host version X does not match binary
# version Y" on a project that builds fine outside the app).
export SAPIOM_SMOKE_AGENT_ENV="$(native "$smoke_home/agent-env.txt")"
# Native, because resolveSpawnTarget resolves this inside the app: a POSIX
# path has no drive letter, so the Windows lookup would never find it.
export SAPIOM_SMOKE_STUB_AGENT="$(native "$stub")"
# CI is not a user.
export SAPIOM_TELEMETRY_DISABLED=1
# Windows: makes Electron log rather than swallow.
export ELECTRON_ENABLE_LOGGING=1

status=0
case "$(uname -s)" in
  Linux)
    # The *-unpacked dir, not the .AppImage: the AppImage wrapper needs FUSE
    # (absent on CI runners) and its extract-and-run fallback both floods the log
    # with an 11k-line file listing and failed to exec the app at all (exit 127).
    # linux-unpacked IS the bundle the AppImage wraps, so every layer these
    # checks cover is identical; the wrapper is verified by launching the
    # .AppImage locally.
    # --no-sandbox: chrome-sandbox is only setuid-root once actually installed.
    app="$rel/linux-unpacked/sapiom"
    if [ -n "${DISPLAY:-}" ]; then
      "$app" --smoke --no-sandbox || status=$?
    else
      # Headless runner: Electron still needs an X display.
      xvfb-run --auto-servernum "$app" --smoke --no-sandbox || status=$?
    fi
    ;;
  Darwin)
    "$rel"/mac-arm64/Sapiom.app/Contents/MacOS/Sapiom --smoke || status=$?
    ;;
  MINGW* | MSYS* | CYGWIN*)
    # The nsis .exe is an installer; smoke the unpacked app it installs.
    # REDIRECTED to a file, not inherited: a GUI-subsystem exe cannot attach to
    # an existing console (piping loses everything) but its handles redirect to a
    # file fine — without this a crash before our own reporting code runs is just
    # an exit code with no message.
    "$rel/win-unpacked/Sapiom.exe" --smoke > "$smoke_home/stdio.txt" 2>&1 || status=$?
    echo "--- app stdout/stderr ---"
    cat "$smoke_home/stdio.txt" || true
    ;;
  *)
    echo "smoke.sh: unsupported platform $(uname -s)" >&2
    exit 2
    ;;
esac

if [ -f "$report_file" ]; then
  echo "--- smoke report ---"
  cat "$report_file"
elif [ "$status" -ne 0 ]; then
  # No file AND a bad exit: the app died before it could report — which is the
  # one case where the exit code is all we have (see the Windows exit-3 bug).
  echo "--- no smoke report written: the app exited ($status) before reporting ---"
fi
exit "$status"
