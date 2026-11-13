---
"@sapiom/agent": minor
---

Keep the type declarations valid on the zod versions the peer range starts from.

The package is now built with zod 4.6.7. To keep its declarations compiling on zod 3.25 and zod 4.0 with `skipLibCheck: false`, `agentManifestSchema` types the `transitions` element as a `ZodUnion` of the same four objects, where it was a `ZodDiscriminatedUnion`. Validation and the parsed type are unchanged. Code that reads that nested schema as a `ZodDiscriminatedUnion`, or reads its `discriminator`, no longer type-checks, so this is a minor release.
