# Configure authentication and runtime inputs

Source: https://docs.sapiom.ai/guides/configure-authentication-and-runtime-inputs

Authentication and agent configuration solve different problems:

- **Your Sapiom sign-in** authorizes use of Agent Studio and Sapiom MCP. It is required for local authoring tools as well as link, deploy, run, inspect, signal, and schedule operations.
- **Agent secrets** are write-only values injected into production step processes, such as `SLACK_BOT_TOKEN`.
- **Runtime defaults** are readable, non-secret input values that the supported run path merges into the next execution.
- **Caller input** belongs to one run and has the highest precedence.

None of these belongs in `sapiom.json` or in committed source.

## Sign in before using the authoring tools

You must authenticate before using Agent Studio or Sapiom MCP to create, edit, check, or locally run an agent. Authentication identifies the user of the authoring surface; it does not determine where an operation executes or whether it creates capability spend.

For Agent Studio launched with `npx`, either connect from the account menu after it opens or request browser sign-in before startup:

```bash
npx @sapiom/agent-studio@latest --login
```

With Sapiom MCP connected to Claude Code or Codex, ask your coding agent to connect your Sapiom account before the first project action. It opens browser sign-in and caches the credential. You can also ask which environment and account it is using, or ask it to disconnect.

Both surfaces reuse the current environment's entry in `~/.sapiom/credentials.json`. The random token in Studio's local URL is different: it protects that one loopback Studio process and is not a Sapiom API key.

## Add an agent secret

Production steps receive configured secrets as environment variables. Local Run does not fetch them from Sapiom; local author code sees only the environment of the process that launched the run.

1. **Open Setup**

   Open the deployed agent in the [Agents dashboard](https://app.sapiom.ai/agents), then select **Settings**. The route still ends in `/secrets`, but the page groups **Secrets**, managed resources, and **Defaults**.

2. **Add or replace the value**

   In **Secrets**, choose **Connect** on the declared key and enter its value. For a hand-authored agent without template declarations, choose **Add credential** and enter the environment-variable name yourself.

   Names use uppercase letters, numbers, and underscores in the dashboard. Start with a letter or underscore. Reserved runtime names, including `PATH`, `SAPIOM_*`, and `WORKFLOWS_*`, are rejected.

3. **Verify presence, not value**

   After saving, the dashboard can show that the key is set. It cannot read the value back. Replacing a value is another write; deleting a key removes it for future step dispatches.

4. **Run again—do not redeploy**

   The runtime resolves the definition's currently configured secrets at every cloud step dispatch. A save applies to subsequent dispatches without rebuilding the agent. It does not alter a step process that is already running.
   If the same key is configured on another agent, the dashboard can offer to reuse it. Accepting the offer performs a server-side **copy**: the browser never receives the value, and the target gets its own copy. Rotating the source later does not rotate the target.

## Set a non-secret runtime default

Template-backed agents can declare configurable fields. In the agent's **Settings → Defaults** group:

1. edit one or more fields;
2. choose **Save change** or **Save changes**;
3. start the next run from Agent Studio, Sapiom MCP, or **Run once** in the dashboard.

The saved value is read for each supported start request, so it applies without a redeploy. **Reset** removes the user-set value and restores the template's declared default. Emptying a field in this form also resets it.

Defaults are not secrets. Their values are readable in the dashboard and through the settings API, and they become part of recorded run input. Do not put credentials or private tokens there.

> **Note: Custom agents have input defaults, but no public settings declaration yet.**
> A hand-authored `defineAgent` build currently publishes the entry-step input schema, not template `settings[]`, `requiredSecrets`, or `defaultInput` declarations. Put a zero-input fallback in the entry Zod schema and pass per-run values from the caller. Do not add undocumented fields to `defineAgent` expecting the dashboard to render them.

## Know which value wins

For starts through Agent Studio **Prod Run**, Sapiom MCP, or dashboard **Run once**, Sapiom assembles entry input from lowest to highest precedence:

1. template `defaultInput`;
2. each template `settings[].default`;
3. user-set values saved under **Defaults**;
4. caller input supplied for this run.

Nested defaults use dotted paths such as `client.email`. After the merge, the entry step's Zod schema still parses the whole value. A stored value cannot bypass the agent's input contract, and a Zod `.default(...)` still supplies a field that none of the four layers set.

The current Studio **Prod Run** button supplies `{}` as caller input, so saved defaults and schema defaults are especially useful there. The dashboard form pre-fills effective values but still submits caller input; explicit submitted fields therefore win when the backend merges again.

> **Caution: A saved default is not a universal definition mutation.**
> Saved defaults are applied by the customer execution endpoint used by Studio, Sapiom MCP, and the dashboard. A schedule keeps the input captured when the trigger was created; changing **Defaults** does not rewrite an already-armed schedule.

## Verify both environments

Use two checks before launch:

- While authenticated to Studio or Sapiom MCP, run locally without any production agent secret or real capability call. Confirm schema defaults work and remember that ordinary host environment variables, filesystem access, and network effects remain real.
- Run the deployed build with a harmless canary secret and saved non-secret default. Confirm the key is listable but its value is not, then pass caller input and confirm it overrides the saved value. Delete the canary afterward.

That is the same clean-room test used for this guide: a one-step agent saw no cloud secret locally, received the configured secret in production, picked up a changed saved default without redeploy, let caller input win, and returned to its code-level default after reset.

- [Credentials and configuration reference](https://docs.sapiom.ai/reference/credentials-and-configuration): Storage, visibility, precedence, value types, and per-action authentication requirements.
- [Local and cloud](https://docs.sapiom.ai/concepts/local-and-cloud): Understand which authoring operations stay on your machine.
