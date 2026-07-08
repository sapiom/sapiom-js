/**
 * `@sapiom/harness` — run coding agents locally under a managed session
 * runtime.
 *
 * Early preview: the session foundation (pty-backed `SessionRuntime`) is
 * available; harness adapters, the local server/UI, analytics and doctor
 * live in sibling modules and land incrementally.
 */
export * from "./runtime/index.js";
