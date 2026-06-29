# sandboxes

Isolated, ephemeral compute. Create a sandbox, write files, run commands, stream output, and tear it down.

```ts
import { sandboxes } from "@sapiom/tools";

const box = await sandboxes.create({ name: "build-01", tier: "small" });
await box.writeFile("/workspace/app.py", "print('hi')");
const { stdout } = await box.exec("python /workspace/app.py");
await box.destroy();
```

## Things to know

- **Sandboxes are live and billed until you stop them.** A sandbox keeps running — and accruing cost — until you call `destroy()` or its `ttl` elapses. Destroy it in a `finally` block, or set a short `ttl`, unless a later step still needs it.

- **`name` is how you find a sandbox again.** Use `attach(name)` to reconnect to an already-running sandbox — for example from another process, or one returned by a coding agent run — without provisioning a new one. `create` provisions a fresh sandbox; `attach` adopts an existing one.

- **`get` and `list` are read-only.** `get(name)` returns a sandbox's metadata and current `status` (e.g. `"running"`, `"stopped"`); `list()` returns all your sandboxes. They return plain info, not a handle — `attach(name)` when you want to operate. Handy for checking readiness or whether a sandbox already exists before creating one.

- **Credentials are not injected automatically.** The sandbox environment is empty by default. Pass anything your workload needs explicitly via `envs` when you create the sandbox.

- **`exec` waits for the command to finish.** It returns once the command exits, with `{ exitCode, stdout, stderr }` — including non-zero exits (a failed command resolves with its real `exitCode`; it does not throw). For commands that run longer than a single request, use `execStream` for live output, or start the process and poll it with `getProcess` / `waitForProcess`.

- **Use `uploadFile` for binary or large files.** `writeFile` sends the whole body in one JSON request and is bounded by the ingress body-size ceiling. `uploadFile(path, content, opts?)` runs a chunked multipart upload (parallel parts, retries, auto-abort on failure) and accepts a `Blob`, `Uint8Array`, or string.

- **`/workspace` is the conventional working directory.** Other capabilities assume it — the `agent` capability clones repos into `/workspace/<slug>`, and `repositories.pushFromSandbox` pushes from there. Keep your files under `/workspace` to stay compatible.

## Reference

`create` · `attach` · `get` · `list` · `exec` · `execStream` · `readFile` · `writeFile` · `uploadFile` · `getProcess` · `waitForProcess` · `destroy`

See the exported types for full signatures and options.
