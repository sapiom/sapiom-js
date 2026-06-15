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

- **Credentials are not injected automatically.** The sandbox environment is empty by default. Pass anything your workload needs explicitly via `envs` when you create the sandbox.

- **`exec` waits for the command to finish.** It returns once the command exits, with `{ exitCode, stdout, stderr }`. For commands that run longer than a single request, use `execStream` for live output, or start the process and poll it with `getProcess` / `waitForProcess`.

- **`/workspace` is the conventional working directory.** Other capabilities assume it — the `agent` capability clones repos into `/workspace/<slug>`, and `repositories.pushFromSandbox` pushes from there. Keep your files under `/workspace` to stay compatible.

## Reference

`create` · `attach` · `exec` · `execStream` · `readFile` · `writeFile` · `getProcess` · `waitForProcess` · `destroy`

See the exported types for full signatures and options.
