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
 */
export function describeWorkflowPrompt(workflow: WorkflowInfo): string {
  return [
    `Add human-readable descriptions to the "${workflow.name}" workflow so its Sapiom canvas explains what each part does.`,
    ``,
    `Edit the workflow definition under ${workflow.path} (usually index.ts):`,
    `1. Give the defineAgent({ ... }) call a one-line \`description\` summarizing what the whole workflow does.`,
    `2. Give every defineStep({ ... }) a one-line \`description\` of what that step does — infer it from the step's own code: its input, the Sapiom services it calls, and where it transitions.`,
    ``,
    `Rules:`,
    `- One sentence each, at most ~120 characters, present tense, plain language — don't just restate the step's name.`,
    `- Only add or refine \`description\` fields. Do not change any logic, control flow, imports, or other fields.`,
    `- The \`description\` field needs a recent @sapiom/agent; if the installed version rejects it, upgrade @sapiom/agent to the latest first.`,
    `- Save when you're done — the Sapiom canvas re-renders automatically, so there's no manual step to run afterwards.`,
  ].join("\n");
}
