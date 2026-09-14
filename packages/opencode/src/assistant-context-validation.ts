/** Safe context failure; deliberately contains no paths, credentials or source text. */
export class AssistantContextError extends Error {
  constructor() {
    super("Studio assistant context could not be verified");
    this.name = "StudioAssistantContextError";
  }
}
export function contextCheck(condition: unknown): asserts condition {
  if (!condition) throw new AssistantContextError();
}

export function contextUuid(value: unknown): asserts value is string {
  contextCheck(
    typeof value === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        value,
      ),
  );
}
