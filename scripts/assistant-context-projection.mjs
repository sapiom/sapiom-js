// Assessment-only native hook. The durable Studio v2 envelope stays unchanged.
export function projectStudioSystem(system) {
  const header = "\n\nStudioAssistantContext/v1\n";
  const boundary = system.lastIndexOf(header);
  if (boundary < 0) return system;
  const marker = system.lastIndexOf("\nStudioAssistantResult/v2:", boundary);
  const start = marker >= 0 ? marker + 1 : 0;
  if (!/^StudioAssistantResult\/v2:[a-f0-9-]{36}\n/.test(system.slice(start)))
    throw new Error("Invalid accepted completion envelope");
  const jsonStart = system.indexOf('\n{"schemaVersion":1,', boundary);
  if (jsonStart < 0) throw new Error("Missing accepted context");
  const context = JSON.parse(system.slice(jsonStart + 1));
  if (context.schemaVersion !== 1 || !Array.isArray(context.guidance))
    throw new Error("Invalid accepted context");
  const guidance = context.guidance.map(({ text, ...record }) => record);
  const stable = context.guidance
    .filter((source) => source.status === "available" && source.text)
    .map((source) => `Studio guidance: ${source.id}\n${source.text}`)
    .join("\n\n");
  return (
    system.slice(0, start) +
    system.slice(boundary + header.length, jsonStart) +
    "\n\n" +
    stable +
    "\n\n" +
    system.slice(start, boundary) +
    header +
    JSON.stringify({ ...context, guidance })
  );
}
