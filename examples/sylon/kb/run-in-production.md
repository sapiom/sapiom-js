# Run in production

Source: https://docs.sapiom.ai/guides/run-in-production

A production run executes a linked agent's ready cloud build. It runs real author code, uses live `ctx.sapiom` capabilities instead of local stubs, and participates in cloud usage metering.

You need a signed-in Sapiom account and a linked agent with a `ready` build. A definition ID alone is not enough: it can survive a failed first deploy without a runnable artifact.

## Start the run

**Agent Studio**

Select the intended agent project and choose **Prod Run**. The action is enabled only when Studio can confirm a ready build and authentication. It is a direct product action: it does not prompt your coding agent or use its credits.

The current Studio button sends `{}` as caller input. Use schema defaults for a no-input happy path, or use your coding agent or the dashboard when you need custom input.

Saved non-secret defaults are merged before that `{}`. See [Configure authentication and runtime inputs](/guides/configure-authentication-and-runtime-inputs) for precedence and the trigger paths that apply them.
**Coding agent**

Ask Claude Code or Codex:

> Start a production run of this linked agent with `name` set to `Docs`. Return the execution ID, then inspect it until it finishes or needs an external signal.

An omitted `input` becomes `{}`. The entry step's schema parses the effective input in the cloud before author code receives it.
**Agents dashboard**

Open the deployed agent and choose **Run once**. The dashboard derives fields from the active entry-step input schema and offers a raw-JSON editor when the contract cannot be represented as simple fields. Submit the form to start the run and open its inspector.
The start request returns after enqueueing the execution. Its durable handoff is:

```json
{ "executionId": "<execution-id>" }
```

This response is not the terminal agent output. Preserve the execution ID and inspect the run.

## What changes from Local Run

1. **The cloud uses the deployed artifact**

   Production does not execute the mutable checkout on your machine. When the run starts, it records the exact `buildRunId` selected for that definition. A later deploy or version-pin change affects future runs, not the in-flight run.

2. **Capability calls are live**

   Calls through `ctx.sapiom.*` reach Sapiom services instead of `.sapiom-dev/stubs.json`. Direct `fetch`, third-party SDKs, and other author effects are also real inside the cloud runtime.

3. **Usage is metered**

   The run consumes the agent-run and runtime meters that apply to the account. Live capability calls can add their own usage. A successful HTTP start only proves the run was enqueued; read the terminal status and evidence before treating the outcome as successful.

> **Note: Build identity is not the execution version counter.**
> The run inspector labels the pinned artifact as **Build &lt;build-id&gt;**. An execution payload can also contain a numeric `version`; that number is an optimistic-lock counter for updates to the run row, not a deploy or release version.

The dogfood journey for these guides deployed a two-step agent from a working tree with an uncommitted marker and ran it with `{ "name": "Docs" }`. The completed cloud output included:

```json
{
  "done": true,
  "greeting": "hello from Sapiom, Docs",
  "deployedFromWorkingTree": true
}
```

That marker verified both boundaries at once: deploy used current local source, and the production run used the resulting immutable build rather than rereading the checkout.

- [Inspect a run](https://docs.sapiom.ai/guides/inspect): Wait for terminal state and read the pinned build, step evidence, lineage, and run-grain charge.
- [Deploy](https://docs.sapiom.ai/guides/deploy): Create a new ready build before starting another run.
