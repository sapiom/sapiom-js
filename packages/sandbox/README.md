# @sapiom/sandbox

Sandbox environment management for the Sapiom SDK. Create isolated execution environments, manage files, and run commands.

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
const sandbox = await SapiomSandbox.create();

// Write a file
await sandbox.writeFile("hello.py", 'print("Hello from the sandbox!")');

// Execute a command and wait for completion
const result = await sandbox.exec("python hello.py");
console.log(result.stdout); // "Hello from the sandbox!"

// Read a file back
const content = await sandbox.readFile("hello.py");

// Clean up
await sandbox.destroy();
```

## API

### `SapiomSandbox.create(opts?)`

Creates a new sandbox and returns a handle for interacting with it.

```typescript
const sandbox = await SapiomSandbox.create({
  apiKey: "sk_...",       // optional, defaults to SAPIOM_API_KEY env var
  image: "python:3.12",  // optional sandbox image
  memory: 512,           // optional memory in MB
  env: { NODE_ENV: "production" },
});
```

**Options:**

| Option    | Type                          | Description                                           |
|-----------|-------------------------------|-------------------------------------------------------|
| `apiKey`  | `string`                      | Sapiom API key. Falls back to `SAPIOM_API_KEY` env var |
| `baseUrl` | `string`                      | Override the sandbox service URL                       |
| `fetch`   | `typeof fetch`                | Pre-configured fetch function (overrides `apiKey`)     |
| `image`   | `string`                      | Sandbox image to use                                   |
| `memory`  | `number`                      | Memory allocation in MB                                |
| `cpu`     | `number`                      | CPU allocation in cores                                |
| `env`     | `Record<string, string>`      | Environment variables                                  |

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

Executes a shell command inside the sandbox. By default, waits for the process to complete.

```typescript
// Wait for completion (default)
const result = await sandbox.exec("npm install");
console.log(result.exitCode); // 0
console.log(result.stdout);
console.log(result.stderr);

// Fire-and-forget
const bg = await sandbox.exec("npm start", { waitForCompletion: false });
console.log(bg.pid); // process ID
```

**Options:**

| Option               | Type                     | Default | Description                            |
|----------------------|--------------------------|---------|----------------------------------------|
| `cwd`                | `string`                 | —       | Working directory for the command       |
| `env`                | `Record<string, string>` | —       | Environment variables for the process   |
| `waitForCompletion`  | `boolean`                | `true`  | Wait for the process to finish          |
| `pollInterval`       | `number`                 | `1000`  | Polling interval in ms                  |
| `timeout`            | `number`                 | `60000` | Timeout in ms when waiting              |

### `sandbox.destroy()`

Destroys the sandbox and releases all associated resources.

```typescript
await sandbox.destroy();
```

## Properties

| Property        | Type     | Description                                |
|-----------------|----------|--------------------------------------------|
| `sandbox.name`  | `string` | Sandbox identifier                          |
| `sandbox.workspaceRoot` | `string` | Absolute workspace root path in the sandbox |

## License

MIT
