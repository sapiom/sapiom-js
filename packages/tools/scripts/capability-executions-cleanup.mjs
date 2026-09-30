/** Preserve every failure while always attempting graceful and forced teardown. */
export async function cleanupExecutionGate(save, harness, active) {
  const errors = [];
  for (const operation of [
    save,
    () => harness.control("shutdown"),
    ...[...active].map((child) => () => child.stop()),
  ]) {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Capability gate cleanup failed.");
}
