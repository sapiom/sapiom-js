---
"@sapiom/cli": patch
---

Add `sapiom sandbox preview [name]` (alias `sbx`): deploy a web-app preview from the current project to a Sapiom sandbox and print the live URL. Reads the sandbox's declared intent from `sapiom.json` (`type: "sandbox"`, singular-default when the project defines exactly one, or pass a name). A `failed` status prints the build/start logs so you can fix and re-run; `--json` emits the structured result.
