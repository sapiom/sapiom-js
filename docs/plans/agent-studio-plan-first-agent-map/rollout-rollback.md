# Unified Agent Map rollout and recovery

## Release gate

Ship desktop beta first. Before a tag, record the exact main SHA, changeset
files, generated release PR, desktop package version, last known good tag, and
the intended `vX.Y.Z-beta.N` tag. Build and smoke the packaged AppImage, inspect
the packaged resources when runtime files changed, and walk the project-map,
ordinary-session, direct-build, and delegation journeys.

The npm path is changeset → merged version PR → publish. The desktop path is a
tag exactly matching `packages/harness-desktop/package.json`. Stable release is
allowed only after beta evidence and the update manifests are present.

## Rollback reality

There is no in-place downgrade for users who already installed a bad npm or
desktop version. Recovery is roll-forward:

1. identify and revert the faulty commit on a new branch;
2. add a new changeset and publish a strictly higher package version;
3. build and publish a strictly higher desktop tag;
4. verify installers, `latest*.yml`, and blockmaps remain available for the
   last known good and new recovery releases;
5. use deprecation only as an installer warning, never as an unpublish plan.

Deleting a tag or release cannot downgrade installed desktop applications and
may strand the updater. `SAPIOM_UPDATE_CHANNEL` is a single-machine diagnostic,
not fleet rollback. Record an out-of-hours approver and drill the full
revert→changeset→version-PR→tag sequence before stable rollout.

## Product-state restoration

Product restoration is separate from binary rollback. A map or plan restore is
an ordinary expected-version write. It appends a new immutable version whose
content matches the selected historical version and whose
`restoredFromVersionId` names that source. The previous history remains
byte-for-byte unchanged, the current pointer advances atomically, and a stale
restore conflicts like any other concurrent write.
