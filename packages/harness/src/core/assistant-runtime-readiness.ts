import type { RetainedAssistantContext } from "./assistant-source-store.js";
import { assistantContextUnavailable } from "./studio-assistant-context.js";

/** Current Studio can project retained text/catalogs; executing retained skill
 * packages requires the future managed-generation materializer. Never claim
 * a live skill directory satisfies an accepted package. Host startup still owns
 * containment/readiness of the existing prepared-skill directories. */
export function assertAssistantRuntimeReady(
  retained: RetainedAssistantContext,
): void {
  for (const source of retained.accepted.instructionSet.sources) {
    if (source.status !== "available") continue;
    const content = retained.sources.get(source.id);
    if (
      !content ||
      content.format !== source.format ||
      content.format === "skill-package"
    )
      throw assistantContextUnavailable();
  }
}
