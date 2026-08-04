/// <reference types="vite/client" />

/** The harness package version, injected at build time by vite.config.ts's
 *  `define` (from packages/harness/package.json). Used by the terminal
 *  masthead so the shown version never drifts from the running build. */
declare const __STUDIO_VERSION__: string;
