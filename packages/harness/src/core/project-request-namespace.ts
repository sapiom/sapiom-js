/** Receipt namespace reserved for trusted canonical refresh after a plan mutation. */
export const INTERNAL_BRIEF_REFRESH_REQUEST_PREFIX = "harness-internal:brief:";

export const isCallerProjectRequestId = (value: string): boolean =>
  !value.startsWith(INTERNAL_BRIEF_REFRESH_REQUEST_PREFIX);
