import {
  resolveCredentialPolicy,
  type CredentialPolicy,
} from "@sapiom/analytics-core/credential";

/** Per call, so the `SAPIOM_ALLOW_INSECURE_HTTP` opt-in is read when the request is made. */
export function harnessCredentialPolicy(): CredentialPolicy {
  return resolveCredentialPolicy(undefined, { label: "@sapiom/harness" });
}
