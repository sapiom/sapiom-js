/**
 * seed.ts — exact file content for the scratch repo `plan` self-provisions on a
 * zero-input run. Kept out of `index.ts` on purpose: these strings are a tiny,
 * self-contained slice of an examples repo (its own `AUTHORING.md` plus two
 * minimal `defineAgent`/`defineStep` examples), so their literal text contains
 * `entry:`, `defineAgent`, and `defineStep` — tokens the static
 * `examples-entry-schema-check` scans `index.ts` for to find THIS template's
 * own entry step. Left inline, the check's first `entry:` match would be the
 * seeded `hello-agent`'s, not `plan`'s. Moving the seed content to its own
 * module (same pattern as `examples/research-to-microsite/critique.ts`) keeps
 * that scan honest without weakening it.
 *
 * Never applied to a `repoSlug` the caller supplied — a real repo's
 * conventions are whatever it already has.
 */

const SEED_AUTHORING_MD = `# Authoring an example

Each example is one directory under \`examples/\`, named for its id (kebab-case). It holds:

- \`index.ts\` — exports \`export const agent = defineAgent({ name, entry, steps })\`, built from \`defineStep\` from \`"@sapiom/agent"\`. Every step declares its \`next\` / \`terminal\` transitions.
- \`template.json\` — \`{ "manifestVersion": 1, "whatItDoes": "...", "useCases": ["...", "...", "..."] }\`.
- \`package.json\` / \`tsconfig.json\` — copy an existing example's, keeping its \`typecheck\` script.

A new example must run \`npm run typecheck\` clean and follow this shape exactly — no other file layout is accepted.
`;

const SEED_HELLO_AGENT_INDEX = `import { defineAgent, defineStep, terminate } from "@sapiom/agent";

const greet = defineStep({
  name: "greet",
  next: [],
  terminal: true,
  async run(input: { name?: string }) {
    return terminate({ message: \`Hello, \${input?.name?.trim() || "world"}!\` });
  },
});

export const agent = defineAgent({ name: "hello-agent", entry: "greet", steps: { greet } });
`;

const SEED_HELLO_AGENT_TEMPLATE = `{
  "manifestVersion": 1,
  "whatItDoes": "Greet whoever runs it.",
  "useCases": ["Smoke test", "Onboarding demo", "Sanity check"]
}
`;

const SEED_ECHO_INDEX = `import { defineAgent, defineStep, terminate } from "@sapiom/agent";

const echo = defineStep({
  name: "echo",
  next: [],
  terminal: true,
  async run(input: { text?: string }) {
    return terminate({ text: input?.text ?? "" });
  },
});

export const agent = defineAgent({ name: "echo", entry: "echo", steps: { echo } });
`;

const SEED_ECHO_TEMPLATE = `{
  "manifestVersion": 1,
  "whatItDoes": "Echo the given text back unchanged.",
  "useCases": ["Wiring check", "Round-trip test", "Debug probe"]
}
`;

// The pinned ranges below resolve on the public npm registry today (checked
// via `npm view @sapiom/agent@^0.9.0 version` → 0.9.3, and
// `npm view @sapiom/tools@^0.25.0 version` → 0.25.0) — `verify`'s `npm
// install` assumes the sandbox reaches the public registry for `@sapiom/*`,
// same as it would for `zod`/`typescript`. If a failure here turns out to be
// resolution rather than a real dependency problem, that assumption — not
// these versions — is the thing to check first (see `verify`'s
// `install-failed` detail).
const SEED_ROOT_PACKAGE_JSON = `{
  "name": "examples-repo",
  "private": true,
  "type": "module",
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": { "@sapiom/agent": "^0.9.0", "@sapiom/tools": "^0.25.0", "zod": "^4.0.0" },
  "devDependencies": { "typescript": "^5.4.2", "@types/node": "^20.11.30" }
}
`;

const SEED_TSCONFIG = `{
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "es2022",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["**/*.ts"]
}
`;

// A real examples repo ignores its installed dependencies. Seeding this keeps
// the very first push clean the moment `verify`'s install populates
// `node_modules/`, so the reviewed branch is the change, not the dependency
// tree. `push` re-asserts the same ignore for BYO/reused repos.
const SEED_GITIGNORE = `node_modules/
package-lock.json
`;

/**
 * Exact-content scaffold instructions, prepended to the real task on a
 * scratch repo only — see `implement` in `index.ts`.
 */
export const SEED_PREAMBLE =
  "This repository is brand new and empty. Before anything else, create exactly " +
  "these files with exactly this content (character for character), so it looks " +
  "like a small, real slice of an examples repo:\n\n" +
  `--- AUTHORING.md ---\n${SEED_AUTHORING_MD}\n` +
  `--- examples/hello-agent/index.ts ---\n${SEED_HELLO_AGENT_INDEX}\n` +
  `--- examples/hello-agent/template.json ---\n${SEED_HELLO_AGENT_TEMPLATE}\n` +
  `--- examples/echo/index.ts ---\n${SEED_ECHO_INDEX}\n` +
  `--- examples/echo/template.json ---\n${SEED_ECHO_TEMPLATE}\n` +
  `--- package.json ---\n${SEED_ROOT_PACKAGE_JSON}\n` +
  `--- tsconfig.json ---\n${SEED_TSCONFIG}\n` +
  `--- .gitignore ---\n${SEED_GITIGNORE}\n\n` +
  "Once those files exist exactly as given, do the task below.\n\n";
