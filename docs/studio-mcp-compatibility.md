# Studio and local MCP compatibility

Studio qualifies the selected MCP executable and can supply authenticated session
context. Shared map activation remains **off**: private `agent_map_*`, build-plan
and delegation tools, matching prompts, the Studio map UI and ELK layout continue
through their existing paths. No MCP map-authoring tools, viewer or external-edit
watcher are advertised by this change.

| Pair or failure                                        | Behavior                                                                                                                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old Studio / new MCP                                   | `SAPIOM_HARNESS_VERSION` selects legacy Studio classification; no competing map tools or standalone viewer.                                                                      |
| New Studio / new MCP                                   | Verify the offline descriptor and package fingerprint; pass private session context to the selected executable. Private map tools remain active.                                 |
| New Studio / old MCP                                   | Missing probe marker means no probe execution. Keep the existing private tools and prompts.                                                                                      |
| CLI dependency old, missing or unbuilt                 | Retain `npx -y @sapiom/mcp@latest`, explicitly unverified. Never qualify one package and launch a fresh registry resolution under that result.                                   |
| Desktop offline or failed refresh                      | Reuse a surviving cached installation; retain the installer's existing npx fallback if none survives. Preflight never installs or refreshes. Private map tools remain available. |
| Resume or package rollback                             | Requalify the current executable before generating configuration and rotate the existing session credential.                                                                     |
| Invalid, revoked or unreachable claimed Studio context | Classify as unavailable Studio. Existing developer tools continue; do not grant standalone map authority.                                                                        |

CLI's verified selection is its installed runtime dependency, not an assertion
that it equals the registry's current `latest`. Desktop always qualifies its
app-managed entry and Electron-as-Node command. Its weekly refresh stays awaited
at boot, before sessions exist. Both hosts preflight every create/resume before
prompt/config generation; coding-client initialization happens later.

The offline `--describe-capabilities` path returns descriptor version, package
version, supported host protocols, map schema versions, implemented features and
an SHA-256 fingerprint of package metadata and executable JS. These versions are
independent of a map's revision. A package version or Studio marker alone proves
neither support nor authority. The fingerprint detects replaced builds, including
same-version replacements; it is not a signature or an immutable dependency tree.
MCP checks it again before using the launch credential.

Studio passes the context URL, opaque credential and expected descriptor through
private per-session MCP configuration. Its authenticated loopback endpoint derives
project, custom state root, user/local principal, session and authority generation
from trusted server state. It rechecks generation after asynchronous lookup and
returns `Cache-Control: no-store`. Model arguments select none of these fields.
Codex receives the bootstrap through environment forwarding, outside argv and its
shell-tool environment. Background and structured-inference tasks receive no
ambient project authority.

`StudioHostContextClient.resolve()` rechecks admission on every call and pins the
initial scope. A returned context is a snapshot, not durable permission for later
filesystem writes. Future Studio map operations must enforce live host admission;
revocation cannot undo already admitted writes or arbitrary filesystem access.
Current host support is only `session-context`; current MCP support is only
`studio-context`. No existing binary gains live external edits from this protocol.

Release the shared library and MCP before relying on the verified pairing in
Studio. Intermediate and mixed releases keep the legacy surface. Map tools,
viewing/watching and coordinated activation are separate follow-up tickets.

Verification combines source-level authority/lifecycle tests, actual MCP tarballs
installed outside the workspace (including their local production dependency
closure), Node 18/20/22 artifact checks and packaged Desktop smoke. The Desktop
smoke executes a real offline MCP through Electron-as-Node and separately exercises
the existing private map read/write path. Linux results do not imply a tested
macOS or Windows artifact; those use the multi-OS Desktop workflow.
