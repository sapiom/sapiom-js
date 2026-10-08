# Studio and local MCP compatibility

Studio qualifies the selected MCP executable and can supply authenticated session
context. The MCP advertises one read-only map tool, `sapiom_dev_map`, which
computes the agent map from code on every call and stores nothing. Studio draws
its project map from the same scan, run in process by the harness, so a session
and Studio see one map. Studio's private `agent_map_*` tools and their
`/mcp/agent-map` endpoint are removed. No MCP map-authoring tools, viewer or
external-edit watcher are advertised.

| Pair or failure                               | Behavior                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Old Studio / new MCP                          | `SAPIOM_HARNESS_VERSION` selects legacy Studio classification; no competing map tools or standalone viewer.                                    |
| New Studio / new MCP                          | Verify the offline descriptor and package fingerprint; launch the selected executable. Sessions get no private map tools.                      |
| New Studio / old MCP                          | Missing probe marker means no probe execution. The session has no `sapiom_dev_map`; Studio still draws the map in process.                     |
| CLI dependency old, missing or unbuilt        | Retain `npx -y @sapiom/mcp@latest`, explicitly unverified. Never qualify one package and launch a fresh registry resolution under that result. |
| Desktop offline or failed refresh             | Reuse a surviving cached installation; retain the installer's existing npx fallback if none survives. Preflight never installs or refreshes.   |
| Desktop entry fails preflight                 | Discard the damaged or unverified command and retain the unqualified npx fallback. Accepted legacy commands keep their existing launch path.   |
| Resume or package rollback                    | Requalify the current executable before generating configuration.                                                                              |
| Invalid or unreachable claimed Studio context | Classify as unavailable Studio. Existing developer tools continue.                                                                             |

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

Studio no longer passes a host context to the MCP: the context endpoint
(`/mcp/agent-map/host-context`) is removed with the stored map. The MCP still
resolves `SAPIOM_STUDIO_HOST_CONTEXT` when an older Studio supplies it and logs a
failure without changing its tools.

`StudioHostContextClient.resolve()` rechecks admission on every call and pins the
initial scope. A returned context is a snapshot, not durable permission for later
filesystem writes. Future Studio map operations must enforce live host admission;
revocation cannot undo already admitted writes or arbitrary filesystem access.
Current host support is only `session-context`; current MCP support is only
`studio-context`. No existing binary gains live external edits from this protocol.

Release the shared library and MCP before relying on the verified pairing in
Studio.

Verification combines source-level authority/lifecycle tests, actual MCP tarballs
installed outside the workspace (including their local production dependency
closure), Node 18/20/22 artifact checks and packaged Desktop smoke. The Desktop
smoke executes a real offline MCP through Electron-as-Node and separately asks
the packaged server for a project map, which loads the `@sapiom/mcp/map` scanner. Linux results do not imply a tested
macOS or Windows artifact; those use the multi-OS Desktop workflow.
