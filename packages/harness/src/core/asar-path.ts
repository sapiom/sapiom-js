/**
 * The one asar path translation, shared.
 *
 * Packaged inside Electron, this package lives in `app.asar` and every path
 * derived from `require.resolve` / `import.meta.url` names that archive.
 * Electron patches `fs`, so reads through the virtual path work — but the
 * syscalls it does NOT patch (a child process's `cwd`, an argv path handed to a
 * plain-Node child, `cpSync`, `opendir`, `chmod`, `spawn` of a binary) hit
 * `app.asar` as a path component, and it is a regular file: `ENOTDIR`.
 *
 * `asarUnpack` (see `harness-desktop/electron-builder.yml`) puts the real file
 * on disk next door in `app.asar.unpacked`, but does NOT change the path the
 * resolver reports — so the translation has to be applied explicitly, every
 * time. This existed as four hand-written copies of the same regex, and
 * `POST /api/runs/local` shipped without one: `spawn ENOTDIR` on every local
 * run in the desktop app. One helper, so a fifth call site can reuse instead of
 * remember.
 *
 * A no-op under the CLI (no archive in the path) and idempotent, so composing
 * translations is safe.
 *
 * The one env var that exists for the same reason lives here too — see
 * {@link HOST_ESBUILD_PIN}.
 */

/** Redirect an `app.asar` path to its unpacked twin on disk. */
export function unpackedPath(path: string): string {
  return path.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
}

/**
 * The env var the desktop host sets for the same reason (see
 * `harness-desktop/src/main/esbuild-binary.ts`): esbuild cannot exec its native
 * binary from inside `app.asar`, so the host pins it to the unpacked twin.
 *
 * It must never cross a process boundary. In-process callers read the pin; a
 * child does not need it (plain Node resolves real on-disk paths itself) and
 * inheriting it breaks any project whose own esbuild is a different version —
 * `Cannot start service: Host version "X" does not match binary version "Y"` on
 * a repo that builds fine outside the app. Named here, once, because the two
 * environment-copying spawners (`session-manager`, `task-manager`) and the
 * run-local child spec all have to strip the same key.
 */
export const HOST_ESBUILD_PIN = "ESBUILD_BINARY_PATH";
