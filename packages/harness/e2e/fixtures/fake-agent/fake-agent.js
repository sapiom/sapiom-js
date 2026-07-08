#!/usr/bin/env node
/**
 * fake-agent — a tiny transcript-driven terminal app that stands in for a
 * real coding agent in harness tests. It is meant to run INSIDE a pty.
 *
 * Usage:
 *   node fake-agent.js [path/to/transcript.json]
 *
 * Defaults to transcripts/basic-echo.json. See README.md in this directory
 * for the transcript format.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const transcriptPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, "transcripts", "basic-echo.json");
const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));

const echoKeystrokes = transcript.echoKeystrokes !== false;

const out = (data) => process.stdout.write(data);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Replace the `{{line}}` placeholder with the last input line, if any. */
function substitute(text, line) {
  return line === undefined ? text : text.split("{{line}}").join(line);
}

async function playStep(step, line) {
  switch (step.type) {
    case "print":
      out(substitute(step.data ?? "", line));
      break;
    case "wait":
      await sleep(step.ms ?? 0);
      break;
    case "busy": {
      // Simulates a busy/idle cycle: spinner frames, then a done line.
      const frames =
        Array.isArray(step.frames) && step.frames.length > 0
          ? step.frames
          : ["-", "\\", "|", "/"];
      const cycles = step.cycles ?? frames.length;
      const label = step.label ?? "working";
      for (let i = 0; i < cycles; i += 1) {
        out(`\r${frames[i % frames.length]} ${label}`);
        await sleep(step.intervalMs ?? 40);
      }
      out(`\r\u001b[K`); // carriage return + clear the spinner line
      if (step.doneData) out(substitute(step.doneData, line));
      break;
    }
    case "print-size":
      out(`[size] ${process.stdout.columns}x${process.stdout.rows}\r\n`);
      break;
    case "print-cwd":
      out(`[cwd] ${process.cwd()}\r\n`);
      break;
    case "print-env":
      out(`[env] ${step.name}=${process.env[step.name] ?? ""}\r\n`);
      break;
    default:
      // Unknown step types are ignored so transcripts can evolve.
      break;
  }
}

async function playSteps(steps, line) {
  for (const step of steps ?? []) {
    await playStep(step, line);
  }
}

let exiting = false;
function shutdown(code) {
  if (exiting) return;
  exiting = true;
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Input handling: raw-mode byte stream, manual line assembly (like a real
// agent TUI). Each completed line replays the transcript's `onLine` steps.
// ---------------------------------------------------------------------------

let inputBuffer = "";
let lineQueue = Promise.resolve();

function handleInput(chunk) {
  const text = chunk.toString("utf8");
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === 0x03) {
      // Ctrl+C
      out("^C\r\n");
      shutdown(130);
      return;
    }
    if (code === 0x04 && inputBuffer.length === 0) {
      // Ctrl+D on an empty line
      shutdown(0);
      return;
    }
    if (ch === "\r" || ch === "\n") {
      const line = inputBuffer;
      inputBuffer = "";
      if (echoKeystrokes) out("\r\n");
      lineQueue = lineQueue.then(() => playSteps(transcript.onLine, line));
    } else if (code === 0x7f || code === 0x08) {
      // Backspace
      if (inputBuffer.length > 0) {
        inputBuffer = inputBuffer.slice(0, -1);
        if (echoKeystrokes) out("\b \b");
      }
    } else {
      inputBuffer += ch;
      if (echoKeystrokes) out(ch);
    }
  }
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.on("data", handleInput);
process.stdin.on("end", () => shutdown(0));
process.stdin.on("error", () => shutdown(0));

process.on("SIGTERM", () => {
  if (transcript.ignoreSigterm) {
    out("\r\n[fake-agent] SIGTERM ignored (transcript.ignoreSigterm)\r\n");
    return;
  }
  shutdown(143);
});

if (transcript.announceResize) {
  process.stdout.on("resize", () => {
    out(`\r\n[resize] ${process.stdout.columns}x${process.stdout.rows}\r\n`);
  });
}

playSteps(transcript.boot).catch((error) => {
  out(`\r\n[fake-agent] transcript error: ${error && error.message}\r\n`);
  shutdown(1);
});
