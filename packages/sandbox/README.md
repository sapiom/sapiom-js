# @sapiom/sandbox

Sandbox environment management for the Sapiom SDK. Create isolated execution environments, manage files, run commands, and stream output in real time.

## Installation

```bash
npm install @sapiom/sandbox
# or
pnpm add @sapiom/sandbox
```

## Quickstart

```typescript
import { SapiomSandbox } from "@sapiom/sandbox";

// Create a sandbox (uses SAPIOM_API_KEY env var by default)
const sandbox = await SapiomSandbox.create({ name: "my-sandbox" });

// Write a file
await sandbox.writeFile("hello.py", 'print("Hello from the sandbox!")');

// Execute a command and wait for completion
const result = await sandbox.exec("python hello.py");
console.log(result.stdout); // "Hello from the sandbox!"

// Stream output from a long-running process
const proc = await sandbox.execStream("node runner.js");
for await (const line of proc.output) {
  console.log(`[${line.stream}] ${line.data}`);
}
console.log("exit code:", proc.exitCode);

// Clean up
await sandbox.destroy();
```

## API

### `SapiomSandbox.create(opts)`

Creates a new sandbox and returns a handle for interacting with it.

```typescript
const sandbox = await SapiomSandbox.create({
  name: "my-sandbox",
  tier: "m",
  ttl: "1h",
  image: "python:3.12",
  envs: { NODE_ENV: "production" },
});
```

**Options:**

| Option    | Type                     | Required | Description                                           |
|-----------|--------------------------|----------|-------------------------------------------------------|
| `name`    | `string`                 | Yes      | Sandbox name (lowercase alphanumeric + hyphens, 2-63 chars) |
| `apiKey`  | `string`                 | No       | Sapiom API key. Falls back to `SAPIOM_API_KEY` env var |
| `baseUrl` | `string`                 | No       | Override the sandbox service URL                       |
| `fetch`   | `typeof fetch`           | No       | Pre-configured fetch function (overrides `apiKey`)     |
| `tier`    | `SandboxTier`            | No       | Memory tier: `'xs'`, `'s'`, `'m'`, `'l'`, `'xl'` (default `'s'`) |
| `ttl`     | `string`                 | No       | Time-to-live (e.g. `'1h'`, `'24h'`, `'7d'`)           |
| `envs`    | `Record<string, string>` | No       | Environment variables                                  |
| `port`    | `number`                 | No       | Single port to expose (mutually exclusive with `ports`) |
| `ports`   | `PortSpec[]`             | No       | Array of port specs to expose (mutually exclusive with `port`) |
| `image`   | `string`                 | No       | Pre-built Docker image for instant creation             |

### `sandbox.writeFile(path, content)`

Writes a file relative to the sandbox's workspace root.

```typescript
await sandbox.writeFile("src/index.ts", 'console.log("hi")');
```

### `sandbox.uploadFile(path, content, opts?)`

Uploads a file using multipart upload. Handles the full `initiate → upload parts → complete` lifecycle, with parallel part uploads and automatic abort on any failure. Prefer this over `writeFile` for binary content or files over a few MB.

```typescript
import { openAsBlob } from "node:fs";

// From a buffer / Uint8Array
await sandbox.uploadFile("data/snapshot.bin", new Uint8Array(bytes));

// From a file on disk without slurping it into memory (Node 20+)
const blob = await openAsBlob("./huge.parquet");
await sandbox.uploadFile("datasets/huge.parquet", blob, {
  partSize: 5 * 1024 * 1024,
  concurrency: 4,
  onPartUploaded: (part, progress) => {
    const pct = ((progress.bytesUploaded / progress.totalBytes) * 100).toFixed(1);
    console.log(`part ${part.partNumber} ok — ${pct}%`);
  },
});

// Cancel a running upload — the server-side multipart session is auto-aborted
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 10_000);
await sandbox.uploadFile("big.bin", blob, { signal: ctrl.signal });
```

**Options:**

| Option            | Type                    | Default         | Description                                                                 |
|-------------------|-------------------------|-----------------|-----------------------------------------------------------------------------|
| `partSize`        | `number`                | `5 * 1024 * 1024` | Part size in bytes. The Sapiom ingress rejects uploads over ~8 MiB, so keep this ≤ 7 MiB. |
| `concurrency`     | `number`                | `4`             | Number of parallel part uploads. Blaxel recommends 3–5.                      |
| `permissions`     | `string`                | `"0644"`        | Unix file permissions.                                                      |
| `signal`          | `AbortSignal`           | —               | Cancel the upload. Triggers an auto-abort of the server-side session.        |
| `onPartUploaded`  | `(part, progress) => void` | —            | Fired after each part finishes (completion order — not `partNumber` order).  |

The server accepts at most **10,000 parts per upload**. If `content.size / partSize > 10_000`, `uploadFile` throws before making any request and suggests a larger `partSize`.

### Low-level multipart API

For resumable uploads or custom retry logic, drive the multipart lifecycle directly:

```typescript
const { uploadId } = await sandbox.initiateMultipartUpload("large.bin");

try {
  // ...upload parts as bytes become available
  const part1 = await sandbox.uploadPart(uploadId, 1, chunk1);
  const part2 = await sandbox.uploadPart(uploadId, 2, chunk2);

  // Inspect server-side state (useful after a crash/reconnect)
  const uploaded = await sandbox.listMultipartParts(uploadId);

  await sandbox.completeMultipartUpload(uploadId, [
    { partNumber: part1.partNumber, etag: part1.etag },
    { partNumber: part2.partNumber, etag: part2.etag },
  ]);
} catch (err) {
  await sandbox.abortMultipartUpload(uploadId);
  throw err;
}
```

| Method                                               | Description                                 |
|------------------------------------------------------|---------------------------------------------|
| `initiateMultipartUpload(path, opts?)`               | Start a session. Returns `{ uploadId, path }`. |
| `uploadPart(uploadId, partNumber, bytes, opts?)`     | Upload one part (1-indexed, 1–10000).        |
| `listMultipartParts(uploadId, opts?)`                | List parts already uploaded.                 |
| `completeMultipartUpload(uploadId, parts, opts?)`    | Commit the upload.                           |
| `abortMultipartUpload(uploadId, opts?)`              | Discard the session and clean up parts.      |

### `sandbox.readFile(path)`

Reads a file relative to the sandbox's workspace root and returns its content as a string.

```typescript
const content = await sandbox.readFile("src/index.ts");
```

### `sandbox.exec(command, opts?)`

Executes a shell command inside the sandbox. By default waits for the process to finish.

```typescript
// Wait for completion (default)
const result = await sandbox.exec("npm install");
console.log(result.exitCode); // 0
console.log(result.stdout);
console.log(result.stderr);

// Fire-and-forget
const bg = await sandbox.exec("npm start", { waitForCompletion: false });
console.log(bg.pid);

// Check on it later
const status = await sandbox.getProcess(bg.pid);
console.log(status.completed, status.exitCode);

// Or wait for it to finish
const final = await sandbox.waitForProcess(bg.pid);
console.log(final.exitCode);
```

**Options:**

| Option               | Type                     | Default | Description                                      |
|----------------------|--------------------------|---------|--------------------------------------------------|
| `cwd`                | `string`                 | —       | Working directory (resolved relative to workspaceRoot) |
| `env`                | `Record<string, string>` | —       | Environment variables for the process             |
| `waitForCompletion`  | `boolean`                | `true`  | Wait for the process to finish                    |
| `pollInterval`       | `number`                 | `1000`  | Polling interval in ms                            |
| `timeout`            | `number`                 | `60000` | Timeout in ms when waiting                        |
| `signal`             | `AbortSignal`            | —       | Signal to cancel the operation                    |

### `sandbox.execStream(command, opts?)`

Executes a command and streams output in real time via an async iterable. Ideal for long-running processes like AI agent runs.

```typescript
const proc = await sandbox.execStream("node agent.js");
for await (const line of proc.output) {
  // line.stream is 'stdout' or 'stderr'
  process.stdout.write(line.data);
}
console.log("exit code:", proc.exitCode);
```

Supports cancellation via `AbortSignal`:

```typescript
const controller = new AbortController();
const proc = await sandbox.execStream("long-task", {
  signal: controller.signal,
});

setTimeout(() => controller.abort(), 30_000);

for await (const line of proc.output) {
  console.log(line.data);
}
```

**Options:**

| Option    | Type                     | Default | Description                                      |
|-----------|--------------------------|---------|--------------------------------------------------|
| `cwd`     | `string`                 | —       | Working directory (resolved relative to workspaceRoot) |
| `env`     | `Record<string, string>` | —       | Environment variables for the process             |
| `signal`  | `AbortSignal`            | —       | Signal to cancel the operation                    |

### `sandbox.getProcess(pid)`

Gets the current status of a process by PID.

```typescript
const status = await sandbox.getProcess(pid);
console.log(status.completed, status.exitCode);
```

### `sandbox.waitForProcess(pid, opts?)`

Waits for a process to complete by polling its status. Returns the same `ExecResult` as `exec()`.

```typescript
const result = await sandbox.waitForProcess(pid, { timeout: 120_000 });
console.log(result.exitCode, result.stdout);
```

### `sandbox.destroy()`

Destroys the sandbox and releases all associated resources.

```typescript
await sandbox.destroy();
```

## Properties

| Property                | Type     | Description                                  |
|-------------------------|----------|----------------------------------------------|
| `sandbox.name`          | `string` | Sandbox identifier                           |
| `sandbox.workspaceRoot` | `string` | Absolute workspace root path in the sandbox  |

## License

MIT
