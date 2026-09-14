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
or establish Mac/Windows execution support through cross-compilation alone. Packaging,
selected-platform installation and platform launch gates follow in the stack. A native
release must use a separate `opencode-runtime-v<version>` tag and remain non-latest so
it cannot replace the Studio desktop update feed. Never run upstream `publish.ts`.
