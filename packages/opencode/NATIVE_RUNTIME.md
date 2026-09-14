# Owned native runtime

`native-runtime.json` pins OpenCode 1.18.29 at commit
`16747470f976aca3d362ad730bcd3fe82ecc2c9a`, its frozen dependency lock, the
baseline Bun compiler and seven cross compilers, and the model catalog input.
The two maintained patches honor disabled nested instruction discovery and expose
the actual user/agent identity at the native system hook. The plugin package API
remains compatible with upstream `@opencode-ai/plugin@1.18.29`.

Run from the SDK checkout on Linux x64 with Node 24.15.0 and Python 3.9+:

```sh
python3 -m unittest discover -s scripts/opencode-runtime -p 'test_*.py'
python3 scripts/opencode-runtime/build.py --work-dir /absolute/new/build-directory
```

The directory must be absent. Allow at least 12 GiB of free disk space. The build
verifies archives before extracting them, verifies compiler bytes before execution,
installs the frozen all-platform dependencies without lifecycle scripts, runs native
instruction/read/request-identity tests, and compiles all twelve upstream targets.
The model snapshot is parsed as JSON data, never imported as JavaScript. Bun's
compiler cache is verified before compilation; unexpected downloads and cwd shadows
fail. `OPENCODE_RELEASE` is never inherited, including when set to `0`.

`--single` builds only Linux x64 for a local smoke check. `build-proof.json` records
the input/recipe digests, toolchain, platform metadata and actual output hashes.
Different build paths may produce different binary bytes; use the resulting hashes,
and do not claim bit-for-bit reproducibility across directories.

This recipe builds artifacts; it does not publish, update the production dependency,
or establish Mac/Windows execution support through cross-compilation alone. Actual
selected-platform installation and launch gates follow in the stack. A native
release must use a separate `opencode-runtime-v<version>` tag and remain non-latest so
it cannot replace the Studio desktop update feed. Never run upstream `publish.ts`.

## Package the verified outputs

Run `python3 scripts/opencode-runtime/pack.py --work-dir <build directory>
--output-dir <new artifact directory> --download-cache <archive cache>` after
a complete build. The packager rejects stale recipe proofs, incomplete matrices
and altered binary bytes. It writes twelve platform tarballs, a small `opencode-ai`
root tarball, and `release-proof.json` with archive and binary digests, source and
compiler pins, licenses, patch identities and build/pack recipe hashes. Tar members
have stable ordering, permissions, ownership and timestamps. These are unpublished
candidates for a separate, non-latest GitHub runtime release.

The root installer retains the upstream OS/CPU/libc/AVX2 and baseline fallback
selection. Its artifact map is ordinary metadata, so pnpm does not download every
platform as an optional dependency. Only the selected URL is installed with package
scripts disabled; the regular binary's SHA256 must match before copying or running
it. Missing metadata, unavailable archives and altered bytes terminate installation.
Only a verified binary that fails to launch may fall back to the baseline target.
Windows invokes an actual `npm-cli.js` using Node, without a shell. HTTPS URLs are
required except loopback HTTP fixtures used by installation tests.

With pnpm 10, approve the exact `opencode-ai@<root tarball URL>` in
`onlyBuiltDependencies`; approving only the package name does not run this URL
dependency's installer. When scripts are disabled, the original launcher stub
remains until the existing managed launcher explicitly runs postinstall.

`installer.test.mjs <patched postinstall path>` simulates all twelve selectors,
baseline retry, cross-device copying and failure boundaries. These simulations
are separate from actual installation and native execution on target operating
systems. The CI artifact contains an explicit candidate proof, not a publishing step.

The platform workflow executes Linux, macOS and Windows on both x64 and arm64.
Each job verifies every candidate archive, rehosts only root metadata URLs on a
loopback fixture, and exercises pnpm 10.34.3 fresh install, disabled-script/manual
bootstrap, wrong hash, missing hash and missing archive. It then runs the production
context plugin against the installed binary and accepted-source filesystem tests.
`native-platform-<runner>` records the selected binary hash/version, root archive
hash, requested archives and command results. Foreign-platform simulations and a
green cross-compile are insufficient: all target execution gates must pass before
claiming support. A failed durability gate remains a release blocker.
