#!/usr/bin/env node

// Keep this path ahead of every normal-server import: probing must work offline,
// without credentials, analytics, remote instructions or a stdio transport.
if (process.argv.slice(2).includes("--describe-capabilities")) {
  const { describeCapabilities } = await import("./capabilities.js");
  process.stdout.write(`${JSON.stringify(await describeCapabilities())}\n`);
} else {
  await import("./server.js");
}
