/**
 * Re-export of the canonical path helpers, which now live in
 * `src/shared/paths.ts` so the SERVER can read them too.
 *
 * They moved because `projectRoots` moved (see `@shared/project-roots`): the
 * server has to derive the same project roots the rail renders, and it cannot
 * import out of `web/src`. These are pure string operations over the absolute
 * paths the server hands out — no `node:path`, no DOM — so one copy serves
 * both hosts. Every existing `./paths` import keeps working through this file;
 * a second implementation on the server side is exactly the drift the shared
 * module exists to prevent.
 */
export * from "@shared/paths";
