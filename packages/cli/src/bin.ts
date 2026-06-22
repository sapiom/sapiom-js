#!/usr/bin/env node
import { buildProgram } from './index.js';
import { fail } from './lib/output.js';

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    // Per-command actions catch their own errors; this is the backstop for
    // parse-time and otherwise-unhandled failures.
    fail(err);
    process.exit(process.exitCode ?? 1);
  });
