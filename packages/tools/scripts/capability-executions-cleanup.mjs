/** Attempt all teardown, then save its outcome without exposing error messages. */
export async function cleanupExecutionGate(save, harness, active) {
  const errors = [];
  const cleanupErrors = [];
  for (const [stage, operation] of [
    ["shutdown", () => harness.control("shutdown")],
    ...[...active].map((child) => ["child_stop", () => child.stop()]),
  ]) {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
      cleanupErrors.push(stage);
    }
  }
  try {
    await save(cleanupErrors);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(errors, "Capability gate cleanup failed.");
}
