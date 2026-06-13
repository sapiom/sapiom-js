# repositories

Private, in-network git repositories — create, get, list, delete, and push a working tree straight from a sandbox.

```ts
import { repositories, agent } from "@sapiom/tools";

const repo = await repositories.create("landing-page");
const run = await agent.coding.run({ task: "Build index.html", gitRepository: repo });
const { pushed, sha } = await repo.pushFromSandbox(run.sandbox, { message: "build: landing" });
```

## Things to know

- **Repositories are hosted by Sapiom, not GitHub.** Clones and pushes are authenticated through the Sapiom git gateway using your tenant credentials — there are no personal access tokens or SSH keys to manage. The `cloneUrl` on a repository is the unauthenticated origin; the credentials to clone it yourself are returned when you create the repo.

- **`pushFromSandbox` requires the repo to already be checked out in the sandbox.** It does not clone — it commits and pushes from the repo's checkout at `/workspace/<slug>`. The straightforward way to get that checkout is to run a coding agent with `gitRepository: repo`, which clones the repo into exactly that path with push access already configured. The two methods are meant to be used together; calling `pushFromSandbox` on a sandbox where the repo was never cloned will fail.

- **`pushFromSandbox` is a no-op when there's nothing to commit.** It returns `{ pushed: false, sha: null }` rather than throwing on an empty diff. A non-null `sha` means a commit was actually created and pushed.

- **Prefer pushing in code over asking the agent to push.** Have the coding agent write files, and use `pushFromSandbox` to commit and push afterward. This keeps publishing exact and repeatable instead of depending on the agent to run git correctly.

- **`delete` is idempotent.** It does not throw if the repository is already gone, so it's safe to call unconditionally during cleanup.

## Reference

`create` · `get` · `list` · `delete` · `attach`, and on a repository instance: `pushFromSandbox` · `delete`.

See the exported types for full signatures.
