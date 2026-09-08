# Compare Vertical layout with the desktop app

Check out the coworker trial branch and install with Node >= 20 and pnpm >= 10
(the repository pins pnpm 10.34.3):

```bash
pnpm install --frozen-lockfile
pnpm studio:elk-preview \
  --source-state-root "$HOME/.sapiom/harness" \
  --state-root "$HOME/.sapiom/studio-elk-trial" \
  --project project_REPLACE_WITH_ID \
  --port 4101
```

Read project IDs from the desktop profile's `studio-projects.json`; repeat
`--project <id>` for each project to compare. The destination must be a new or
empty directory outside the source profile. Mapless projects with active
initialization are excluded and reported. Leave the desktop app running on its own port.
At least one imported project root must be accessible; reconnect a missing
directory before launching. The state directory is never registered as a project.

The command builds this branch's dependencies and Studio, then serves the built
SPA from the real localhost server with `mapLayout=elk`. It prints the branch,
commit, snapshot time, canonical profile paths, project IDs, and authorized
browser URL. `--no-open` prints the URL without opening a browser. An occupied
port fails with instructions to choose another; `--port 0` selects a free port.

Reopen the same snapshot, preserving map edits and initialization attempts:

```bash
pnpm studio:elk-preview --state-root "$HOME/.sapiom/studio-elk-trial" --port 4101
```

A fresh snapshot requires a distinct new destination. Nonempty profiles with
missing or damaged manifests are rejected. One trial process may use a comparison profile
at a time; Ctrl+C closes it. An interrupted process can leave a claim file whose
PID must be checked before removing that stale file.

Saved maps and their full history are copied unchanged. Only projects with no
authored map use the existing discovery-gated initializer, without opening a
session or executing agent code. Install and authenticate Claude Code or Codex
on the terminal PATH for that inference; desktop-managed binaries may not be
on PATH. Doctor reports the available provider. With none available, saved maps
remain viewable and mapless projects show `provider_unavailable`. After provider
setup, restart the trial and explicitly Retry failed initialization. Credential
failures use the same normal failure/retry flow. Native provider authentication
remains shared; credentials are never copied and telemetry is disabled.

Comparison state is isolated, but registered agent source directories are shared.
Viewing and initialization leave them unchanged. For comparison feedback, record:

- The printed commit and snapshot time; compare the same saved revision and
  node/edge counts in desktop and localhost before making test-map edits.
- Classic versus Vertical in localhost, including normal and expanded views,
  selection, disconnected groups, and legibility with many agents.
- Node/edge additions and removals in the trial's map state, restart persistence,
  visible errors, layout duration, and interaction responsiveness. Agent source
  edits, sessions, deployments, and runs are ordinary actions on shared projects.
