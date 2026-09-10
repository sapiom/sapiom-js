#!/usr/bin/env node
// =============================================================================
// scripts/examples-app-screenshot.mjs
//
// Capture `examples/<id>/preview.png` — the screenshot `template.json` →
// `app.preview` points at — by actually running the template's dashboard.
//
// The detail page's dashboard card renders the image at 1200×760, so the page
// is opened at exactly that viewport (2× device pixels, so it stays crisp on a
// retina display) and captured as-is — no full-page scroll, no cropping: what
// fits in the card is what the author sees here. The dashboard is started the
// way the publish step will start it (`app.build`, then `app.start`, inside
// `app.entry`), so a start command that doesn't work is found here rather than
// on the first clone.
//
// Waits for the page to mark itself ready (`<body data-ready="true">`, the
// convention the pilot uses once its data has rendered) and otherwise for the
// network to go idle — so the capture is of content, not of a loading state.
//
// Usage:  pnpm examples:app:screenshot <template-id>
//         (needs a browser once: `pnpm exec playwright install chromium`)
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [id] = process.argv.slice(2);

const WIDTH = 1200;
const HEIGHT = 760;
const START_TIMEOUT_MS = 60_000;

if (!id) {
  console.error("usage: pnpm examples:app:screenshot <template-id>");
  process.exit(2);
}

const dir = path.join(ROOT, "examples", id);
const manifestPath = path.join(dir, "template.json");
if (!existsSync(manifestPath)) {
  console.error(`no template.json at ${path.relative(ROOT, manifestPath)}`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const app = manifest.app;
if (!app) {
  console.error(`"${id}" declares no \`app\` block — nothing to screenshot.`);
  process.exit(2);
}

const cwd = path.join(dir, app.entry);
const out = path.join(dir, "preview.png");
const url = `http://localhost:${app.port}/`;

// Detached on POSIX so the shell and the server it spawns form one process
// group, which `stop` can signal as a whole — killing only the shell would
// leave `node server.mjs` alive and the port bound for the next run. Windows
// has no process groups; there the shell is killed and its child is left to
// exit on its own.
function sh(command) {
  return spawn(command, {
    cwd,
    shell: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "inherit", "inherit"],
  });
}

/** Signal the whole process group and wait for the child to actually close. */
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  const closed = new Promise((resolve) => child.once("close", resolve));
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  return closed;
}

function waitForExit(child, label) {
  return new Promise((resolve, reject) => {
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} exited ${code}`)),
    );
    child.on("error", reject);
  });
}

async function waitForServer(child) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let exited = null;
  child.on("exit", (code) => {
    exited = code;
  });
  while (Date.now() < deadline) {
    if (exited !== null)
      throw new Error(`\`${app.start}\` exited ${exited} before serving`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `\`${app.start}\` did not answer on ${url} within ${START_TIMEOUT_MS / 1000}s`,
  );
}

if (app.build) {
  console.log(`build: ${app.build}  (in ${path.relative(ROOT, cwd)})`);
  await waitForExit(sh(app.build), "build");
}

console.log(`start: ${app.start}  (in ${path.relative(ROOT, cwd)})`);
const server = sh(app.start);
let browser;
try {
  await waitForServer(server);
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  await page.goto(url, { waitUntil: "networkidle" });
  await page
    .waitForSelector("body[data-ready='true']", { timeout: 15_000 })
    .catch(() => {
      console.warn(
        "page never set body[data-ready]; capturing after network idle",
      );
    });
  await page.screenshot({ path: out, type: "png" });
  console.log(`wrote ${path.relative(ROOT, out)} (${WIDTH}×${HEIGHT} @2x)`);
} finally {
  await browser?.close();
  await stop(server);
}
