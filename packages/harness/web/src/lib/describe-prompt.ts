import type { WorkflowInfo } from "@shared/types";

/**
 * The prompt behind the canvas "Describe with AI" action.
 *
 * The canvas descriptions are deterministic Option-A fields: the renderer reads
 * `description` off `defineAgent` / `defineStep` in the workflow source (no LLM
 * in the render path). This action hands the bound agent the one job that DOES
 * need a reading of the code — writing those `description` fields — and leaves
 * everything downstream deterministic. The output is durable, editable, and
 * version-controlled because it lives in the source, and the canvas re-renders
 * itself the moment the file saves (the source watcher already re-extracts).
 *
 * It runs as a HEADLESS `claude -p --permission-mode acceptEdits` task: only
 * file edits are auto-approved, so the prompt is scoped to editing the source
 * and explicitly forbids commands (a stray `npm`/test/`git` call would stall or
 * be denied and leave the run producing nothing).
 */
export function describeWorkflowPrompt(workflow: WorkflowInfo): string {
  return [
    `Add human-readable descriptions to the "${workflow.name}" workflow so its Sapiom canvas explains what each part does.`,
    ``,
    `Edit the workflow definition file(s) under ${workflow.path} (the entry is usually index.ts):`,
    `1. Give the defineAgent({ ... }) call a one-line \`description\` summarizing what the whole workflow does.`,
    `2. Give every defineStep({ ... }) a one-line \`description\` of what that step does — infer it from the step's own code: its input, the Sapiom services it calls, and where it transitions.`,
    ``,
    `Rules:`,
    `- One sentence each, at most ~120 characters, present tense, plain language — don't just restate the step's name.`,
    `- Edit the source ONLY: add or refine \`description\` fields and nothing else. Do not change logic, control flow, imports, or other fields.`,
    `- Run NO commands — no npm/pnpm, no build, no tests, no git. Just make the edits and save. (The \`description\` field is supported by @sapiom/agent 0.7.0+, which this project already uses.)`,
    `- When the edits are saved you're done — the Sapiom canvas re-renders automatically, with no further step.`,
  ].join("\n");
}
