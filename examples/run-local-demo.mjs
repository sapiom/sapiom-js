#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = process.argv[2];
const scriptArgs = process.argv.slice(3);

if (!script) {
  console.error("Usage: node ../run-local-demo.mjs <tsx-script> [...args]");
  process.exit(2);
}

const port = process.env.DUMMY_SERVER_PORT ?? "3101";
const dummyServerUrl = `http://localhost:${port}`;
const serverPath = path.join(__dirname, "local-demo-server.mjs");

const server = spawn(process.execPath, [serverPath], {
  cwd: __dirname,
  env: { ...process.env, DUMMY_SERVER_PORT: port },
  stdio: ["ignore", "pipe", "inherit"],
});

let ready = false;
server.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (text.includes("Local Sapiom demo server listening")) ready = true;
});

async function waitForServer() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (ready) return;
    try {
      const response = await fetch(`${dummyServerUrl}/api/public/status`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `local demo server did not become ready at ${dummyServerUrl}`,
  );
}

try {
  await waitForServer();
} catch (error) {
  server.kill("SIGTERM");
  console.error(error.message);
  process.exit(1);
}

const child = spawn("npx", ["tsx", script, ...scriptArgs], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DUMMY_SERVER_URL: dummyServerUrl,
  },
  stdio: "inherit",
  shell: process.platform === "win32",
});

const [code, signal] = await once(child, "exit");
server.kill("SIGTERM");
if (signal) process.kill(process.pid, signal);
process.exit(code ?? 1);
