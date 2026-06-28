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

- **`exec` waits for the command to finish.** It returns once the command exits, with `{ exitCode, stdout, stderr }` — including non-zero exits (a failed command resolves with its real `exitCode`; it does not throw). For commands that run longer than a single request, use `execStream` for live output, or start the process and poll it with `getProcess` / `waitForProcess`.

- **Use `uploadFile` for binary or large files.** `writeFile` sends the whole body in one JSON request and is bounded by the ingress body-size ceiling. `uploadFile(path, content, opts?)` runs a chunked multipart upload (parallel parts, retries, auto-abort on failure) and accepts a `Blob`, `Uint8Array`, or string.

- **`/workspace` is the conventional working directory.** Other capabilities assume it — the `agent` capability clones repos into `/workspace/<slug>`, and `repositories.pushFromSandbox` pushes from there. Keep your files under `/workspace` to stay compatible.

## Deploying an app

`deploy` uploads a file map to an existing sandbox, installs dependencies, and starts the entrypoint — it resolves once the app is running, and its `url` is the app's address on the Sapiom compute domain (`https://<name>.compute.<domain>`).

`createPreview` is a separate, lower-level surface: it asks the platform to mint a public HTTPS URL that proxies to a **specific port** inside the sandbox — independent of `deploy`. Reach for it to expose an arbitrary port, control public-vs-token access, pin a stable preview name, or front it with a custom domain.

```ts
import { sandboxes } from "@sapiom/tools";

const box = await sandboxes.create({ name: "my-api", port: 3000 });
const { url, status } = await box.deploy({
  files: {
    "package.json": JSON.stringify({ scripts: { start: "node index.js" } }),
    "index.js":
      'require("http").createServer((_, res) => res.end("hi")).listen(3000);',
  },
  entrypoint: "node index.js",
});
// url → the compute-domain app URL (set when COMPUTE_PREVIEWS_ENABLED); status → "running"

// Or mint a public URL for a specific port (Blaxel preview, independent of deploy):
const preview = await box.createPreview({ port: 3000 });
preview.url; // https://…
```

A `defineStep` that builds in the sandbox, deploys, and returns the URL:

```ts
import { defineStep } from "@sapiom/orchestration";

export const release = defineStep(
  "release",
  async (ctx, input: { repo: string }) => {
    const box = await ctx.sapiom.sandboxes.create({
      name: input.repo,
      port: 3000,
    });
    try {
      const repo = await ctx.sapiom.repositories.get(input.repo);
      await box.exec(`git clone ${repo.cloneUrl} /workspace/${input.repo}`);
      const build = await box.exec("npm run build", { cwd: input.repo });
      if (build.exitCode !== 0)
        throw new Error(`build failed: ${build.stderr}`);

      const { url, status } = await box.deploy({
        files: {
          "index.js": await box.readFile(`${input.repo}/dist/index.js`),
        },
        entrypoint: "node index.js",
      });
      return { url, status };
    } catch (err) {
      await box.destroy(); // only on failure — a running app needs its sandbox alive
      throw err;
    }
  },
);
```

> **PREVIEW-grade.** Both surfaces are sandbox-TTL-bound — the app/preview lives only as long as the sandbox (~4h by default) — and `deploy` is node-only. `deploy`'s `url` is non-null only when the gateway has `COMPUTE_PREVIEWS_ENABLED` (otherwise the app is reachable only from inside the platform); `createPreview` mints its URL through the platform's preview feature and is not bound to that flag. Durable, auto-scaling hosting that outlives a sandbox is a separate capability. A deployed app keeps the sandbox **running and billed** — don't `destroy()` it while you still need the URL.

## Reference

`create` · `attach` · `exec` · `execStream` · `readFile` · `writeFile` · `uploadFile` · `deploy` · `createPreview` · `getProcess` · `waitForProcess` · `destroy`

See the exported types for full signatures and options.
