#!/usr/bin/env node
// =============================================================================
// Fixture "claude" binary for e2e-live.ts. A real `claude` can't run
// unattended/unauthenticated in CI, so this stands in as the claude-code
// adapter's `binary` — it captures the argv/env the adapter actually
// launched it with (proving the --settings/--mcp-config/--append-system-
// prompt injection worked) to $FAKE_CLAUDE_CAPTURE, then stays alive like an
// interactive session so the pty lifecycle (running -> exited) behaves
// realistically. It does NOT need to read or echo stdin itself — a pty's
// kernel line discipline echoes written input back on its own, regardless
// of what the child process does with it.
// =============================================================================
import { writeFileSync } from "node:fs";

const capturePath = process.env.FAKE_CLAUDE_CAPTURE;
if (capturePath) {
  writeFileSync(
    capturePath,
    JSON.stringify(
      {
        argv: process.argv.slice(2),
        env: {
          SAPIOM_HARNESS_INGEST_URL: process.env.SAPIOM_HARNESS_INGEST_URL ?? null,
          SAPIOM_HARNESS_INGEST_TOKEN: process.env.SAPIOM_HARNESS_INGEST_TOKEN ?? null,
          SAPIOM_HARNESS_SESSION_ID: process.env.SAPIOM_HARNESS_SESSION_ID ?? null,
        },
      },
      null,
      2,
    ),
  );
}

process.stdin.resume();
