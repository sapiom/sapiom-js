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
const proc = await sandbox.exec("node runner.js", { stream: true });
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
| `port`    | `number`                 | No       | Single port to expose                                  |
| `ports`   | `PortSpec[]`             | No       | Array of port specs to expose                          |
| `image`   | `string`                 | No       | Pre-built Docker image for instant creation             |

### `sandbox.writeFile(path, content)`

Writes a file relative to the sandbox's workspace root.

```typescript
await sandbox.writeFile("src/index.ts", 'console.log("hi")');
await sandbox.writeFile("binary.dat", new Uint8Array([0x00, 0xff]));
```

### `sandbox.readFile(path)`

Reads a file relative to the sandbox's workspace root and returns its content as a string.

```typescript
const content = await sandbox.readFile("src/index.ts");
```

### `sandbox.exec(command, opts?)`

Executes a shell command inside the sandbox. Three modes:

#### Wait for completion (default)

```typescript
const result = await sandbox.exec("npm install");
console.log(result.exitCode); // 0
console.log(result.stdout);
console.log(result.stderr);
```

#### Fire-and-forget

```typescript
const bg = await sandbox.exec("npm start", { waitForCompletion: false });
console.log(bg.pid);
```

#### Streaming

Real-time output via async iterable — ideal for long-running processes:

```typescript
const proc = await sandbox.exec("node agent.js", { stream: true });
for await (const line of proc.output) {
  // line.stream is 'stdout' or 'stderr'
  process.stdout.write(line.data);
}
console.log("exit code:", proc.exitCode);
```

Supports cancellation via `AbortSignal`:

```typescript
const controller = new AbortController();
const proc = await sandbox.exec("long-task", {
  stream: true,
  signal: controller.signal,
});

setTimeout(() => controller.abort(), 30_000);

for await (const line of proc.output) {
  console.log(line.data);
}
```

**Options:**

| Option               | Type                     | Default | Description                                      |
|----------------------|--------------------------|---------|--------------------------------------------------|
| `cwd`                | `string`                 | —       | Working directory (resolved relative to workspaceRoot) |
| `env`                | `Record<string, string>` | —       | Environment variables for the process             |
| `waitForCompletion`  | `boolean`                | `true`  | Wait for the process to finish (ignored when streaming) |
| `pollInterval`       | `number`                 | `1000`  | Polling interval in ms                            |
| `timeout`            | `number`                 | `60000` | Timeout in ms when waiting                        |
| `stream`             | `boolean`                | `false` | Stream output via async iterable                  |
| `signal`             | `AbortSignal`            | —       | Signal to cancel the operation                    |

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
