# Credentials and configuration

Source: https://docs.sapiom.ai/reference/credentials-and-configuration

## Credential boundaries

| Credential or value        | Stored or supplied                                                | Visible after write                                                          | Used by                                                                    |
| -------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Studio access token        | Random per launch; carried in the loopback URL and local requests | Printed only for CLI launches that do not open the browser                   | Protects one `127.0.0.1` Studio HTTP/WebSocket server                      |
| Cached Sapiom sign-in      | Current environment entry in `~/.sapiom/credentials.json`         | Account identity is visible; protect the file because it contains an API key | Desktop Studio, `npx` Studio, and the local `@sapiom/mcp` authoring server |
| Runtime-injected agent key | Supplied by Sapiom inside a production run                        | Not returned to agent source or stored in the project                        | The production step's `ctx.sapiom` client                                  |
| Agent secret               | Written to one cloud agent definition                             | Key name only                                                                | Production step processes as `process.env[KEY]`                            |
| Runtime default            | Stored separately on one cloud definition                         | Path and value are readable                                                  | Entry input for supported future run starts                                |
| Caller input               | Sent by the run initiator                                         | Recorded as effective run input                                              | One execution                                                              |

The Studio access token and the Sapiom API key are not interchangeable. `sapiom.json` contains project identity and resources, never either credential.

## Studio and Sapiom MCP sign-in

### `npx` launch behavior

- With a cached credential, Studio reuses it without opening OAuth.
- With no cache, the host can open before authentication completes, but Studio authoring and its session-scoped Sapiom MCP require you to connect an account.
- `--login` starts browser OAuth only when no credential is cached; it does not force a fresh login.
- `--no-auth` skips credential file and authentication network access during startup. It is a diagnostic launch option, not an unauthenticated authoring mode; use **Connect account** before using Studio or Sapiom MCP.

The desktop app probes the same cache. On a clean non-test launch, it starts browser authentication as part of setup. If authentication is cancelled, times out, or is otherwise unavailable, retry **Connect account** before using Studio's authoring features.

### Sapiom MCP tools

| Tool                  | Effect                                                                         |
| --------------------- | ------------------------------------------------------------------------------ |
| `sapiom_authenticate` | Opens browser authentication and writes the current environment's cache entry. |
| `sapiom_status`       | Reports the selected environment and whether a credential is available.        |
| `sapiom_logout`       | Clears the cached credential for the selected environment.                     |

Keep `~/.sapiom/credentials.json` private. Studio creates it with owner-only permissions, but backups, shell history, and copied diagnostics can still expose it. Never paste its contents into an issue or prompt.

## Authentication by action

| Action                                       | Sapiom sign-in required? | Notes                                                                                                                                                  |
| -------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Open/edit through Agent Studio or Sapiom MCP | Yes                      | Coding-agent authentication is separate and belongs to Claude Code or Codex. Editing raw files outside Sapiom is outside this product access boundary. |
| Check or Local Run                           | Yes                      | Authentication grants access to the authoring surface. The operation stays local; Local Run does not download cloud secrets or call real capabilities. |
| Browse or use a template                     | Yes                      | The live gallery also reads Sapiom cloud state. Bundled starter source is local but remains part of the authenticated authoring workflow.              |
| Link, deploy, or Prod Run                    | Yes                      | Deploy can use metered cloud build compute; production calls are live.                                                                                 |
| Inspect, signal, or manage schedules         | Yes                      | These operate organization-owned cloud state.                                                                                                          |

## Agent secrets

Secrets are scoped to a cloud definition. The read contract is names-only: `GET /v1/workflows/definitions/:id/secrets` returns `{ "keys": [...] }`, while writes and deletes return no value. There is no supported read-back path.

### Key contract

- use a JavaScript environment identifier beginning with a letter or underscore;
- the dashboard normalizes entry to uppercase `A-Z`, `0-9`, and `_`;
- maximum key length is 256 characters;
- `PATH`, names beginning `SAPIOM_` or `WORKFLOWS_`, and prototype-related keys are reserved;
- one definition can configure at most 256 keys;
- a value can contain up to 16,000 characters.

The dashboard's `.env` import preserves each accepted secret value rather than trimming it. Invalid lines can be reported without echoing their value.

At every production step dispatch, the runtime resolves that definition's configured values and injects them into the step process. An undeclared or unconfigured key is absent. Replacing or deleting a key affects later step dispatches; it does not mutate a process already running.

Server-side reuse copies a value from one owned definition to another. It is not a live reference. Each copy must be rotated or deleted independently.

## Runtime defaults

Runtime defaults are non-secret values stored separately from agent secrets. The read endpoint returns only rows a user explicitly set, including each dotted path, value, and last-update time. An untouched declared default has no stored row.

Supported stored value shapes are:

- string, including email and cron text;
- finite number;
- boolean;
- flat array of strings.

A path is one or more JavaScript-identifier segments, such as `deliverTo` or `client.email`. Objects belong in the path structure, not in the stored value. Prototype-related path segments are rejected.

Saving `null` or omitting a setting value resets that path by deleting its stored row. `false`, `0`, and a non-empty string are real stored values, not resets.

### Merge precedence

Supported customer run starts assemble input in this order, with later layers winning:

```text
template defaultInput
  → template settings[].default
  → stored definition values
  → caller input
  → entry-step Zod parse
```

Stored values are read at run start. They take effect on the next supported run without a deploy and do not modify an execution already started.

> **Caution: Trigger coverage.**
> This merge currently runs for the customer execution endpoint used by Agent Studio **Prod Run**, Sapiom MCP, and dashboard **Run once**. Schedules execute the input captured when the trigger was created, so re-arm a schedule to change what it sends.

Template manifests can declare `requiredSecrets`, `settings`, and `defaultInput`. The current hand-authored `defineAgent` manifest does not export those declarations. Its entry Zod schema and caller input remain authoritative; do not invent `defineAgent` properties to configure the dashboard.
