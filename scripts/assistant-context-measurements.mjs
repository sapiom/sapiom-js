export function measurementFailures({ sourceReads, sources, calls }) {
  const failures = [];
  if (
    sources.length !== sourceReads ||
    sources.some((source) => source.error || source.status !== 200)
  )
    failures.push("source-observations");
  if (calls.some((call) => call.observationError))
    failures.push("provider-observations");
  return failures;
}
