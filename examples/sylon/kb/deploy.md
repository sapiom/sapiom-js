# Deploy

Source: https://docs.sapiom.ai/guides/deploy

Deploy turns the source currently on your machine into an immutable cloud build. It does not start an agent run.

Before deploying, make sure the project:

- passes `npm run typecheck` and `sapiom_dev_agents_check`;
- has a clean local test for the branch you intend to ship;
- contains valid `sapiom.json` project metadata;
- is a Git repository with at least one commit; and
- is connected to a signed-in Sapiom account.

> **Caution: Deploy ships the working tree, not Git HEAD.**
> Deploy bundles current local source reachable from `index.ts`, including uncommitted edits and imported untracked source. It writes that bundle and a generated dependency manifest into a synthesized build tree. A commit is a precondition, but your current commit is not the deployed release identity. Use the returned build ID to identify what a production run used.

## Deploy with Agent Studio or your coding agent

**Agent Studio**

Bind the intended session to the agent project and select **Deploy** in the action bar. Deploy is a direct product action: it does not prompt your coding agent or use its credits.

Studio disables the action while signed out. On a project's first deploy, Studio resolves or creates the hosted agent by the definition name, writes its `definitionId` to `sapiom.json` when possible, then starts the build. The lifecycle chip moves through **Draft**, **Linked**, **Building**, and **Deployed**; a terminal failure reads **Deploy failed**.
**Coding agent**

Ask Claude Code or Codex:

> Confirm which Sapiom account and environment I am using. Sign me in if needed, link this checked project to a cloud agent, and deploy its current working tree. Return the definition ID, build ID, and final build status.

On first deploy, the project name is read from `defineAgent(...)` and the resolved definition ID is recorded in `sapiom.json`.
A successful deploy returns stable fields in this shape:

```json
{
  "definitionId": "<definition-id>",
  "buildRunId": "<build-id>",
  "status": "ready"
}
```

Keep `buildRunId` when you need an exact deployment identity. The generated commit SHA visible in the dashboard describes the synthesized build repository; it is not proof that your local working tree was clean.

## What happens during deploy

1. **Validate local project state**

   The deploy path requires a linked definition, readable project configuration, and a Git repository with at least one commit. It then bundles `index.ts` and its local imports against the installed package versions.

2. **Push a synthesized source tree**

   Sapiom mints a short-lived push credential. The client creates a temporary tree containing the bundled `index.ts` and generated `package.json`, commits that tree, and pushes it to the agent's managed build repository. The temporary tree is removed after the push.

3. **Create the cloud build**

   The cloud installs declared dependencies and validates the build artifact. Cloud builds can consume metered build compute. The authoring tool waits up to five minutes for `ready`, `failed`, `cancelled`, or `superseded`.

4. **Record the ready build**

   A `ready` build can serve production runs. Agents following latest resolve their newest ready build; a version pin keeps future runs on the selected ready build until you choose **Resume following latest** in the dashboard.

## If deploy does not become ready

- **Failed** means the cloud build returned an error. Read the returned build error, fix the local source or dependencies, run the local checks again, and redeploy.
- **Superseded** means a newer deploy replaced this build while it was in flight. Inspect or wait for the newer build instead.
- **Cancelled** is a terminal build state, but neither Agent Studio nor Sapiom MCP exposes a build-cancel control.
- **Timed out locally** means the five-minute client wait expired; the build may still exist. Inspect it by `buildRunId` instead of starting duplicate deploys blindly.

Redeploying creates a new build. It does not change the build recorded on a production run that already started.

- [Run in production](https://docs.sapiom.ai/guides/run-in-production): Start a real cloud execution from the ready agent and keep its execution ID.
- [Local and cloud](https://docs.sapiom.ai/concepts/local-and-cloud): Review the authentication, execution, and metering boundary.
