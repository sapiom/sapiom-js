#!/usr/bin/env node

import { AgentStudioLaunchError, launchAgentStudio } from "../lib/launcher.mjs";

try {
  await launchAgentStudio();
} catch (error) {
  if (error instanceof AgentStudioLaunchError) {
    console.error(
      `Agent Studio failed to launch [${error.code}]: ${error.message}`,
    );
    if (error.hint) console.error(error.hint);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Agent Studio failed to launch: ${message}`);
  }
  process.exitCode = 1;
}
