/** Package-private bridge between the published build carrier and agent calls. */

const AGENT_RUNTIME_PROVENANCE_VERSION = 1 as const;
const MAX_OPAQUE_TOKEN_LENGTH = 8_192;

interface CallsiteRecord {
  readonly callsite: string;
  active: boolean;
}

const invocationCallsites = new WeakMap<object, CallsiteRecord>();

function supportedOpaqueToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_TOKEN_LENGTH &&
    !/[\r\n]/.test(value)
  );
}

/** Called only by the published build carrier. Snapshots scalars after validation. */
export function registerAgentRuntimeCallsite(
  spec: object,
  version: unknown,
  callsite: unknown,
): void {
  if (
    version !== AGENT_RUNTIME_PROVENANCE_VERSION ||
    !supportedOpaqueToken(callsite)
  ) {
    return;
  }
  const record: CallsiteRecord = {
    callsite: `${callsite}`,
    active: true,
  };
  invocationCallsites.set(spec, record);
  const timer = setTimeout(() => {
    record.active = false;
  }, 0);
  timer.unref?.();
}

/** Consume one validated build callsite. Receipt state never enters this module. */
export function takeAgentRuntimeCallsite(spec: object): string | undefined {
  const record = invocationCallsites.get(spec);
  invocationCallsites.delete(spec);
  const callsite =
    record?.active && supportedOpaqueToken(record.callsite)
      ? record.callsite
      : undefined;
  if (record) record.active = false;
  return callsite;
}
