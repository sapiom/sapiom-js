/**
 * `@sapiom/harness` — run coding agents locally under a managed session
 * runtime.
 *
 * Early preview: the session foundation (pty-backed `SessionRuntime`) and
 * the harness adapter registry are available; the local server/UI,
 * analytics and doctor live in sibling modules and land incrementally.
 */
export * from "./runtime/index.js";
export * from "./harnesses/index.js";
