# Durable capability executions (API version 1)

```ts
import { createClient } from "@sapiom/tools";
const client = createClient({ apiKey, coreBaseUrl: "https://api.sapiom.ai" });
const submission = client.executions.prepare("web.scrape", { url });
// Persist submission BEFORE sending if recovery across a process restart is needed.
const handle = await client.executions.submit(submission);
const state = await client.executions.get(handle.receipt.id);
if (state.status === "succeeded") console.log(state.result);
```

Explicit execution calls require a backend with admission enabled for that capability.
Existing capability methods continue to use their current transport.
The `@sapiom/tools/executions` subpath also exports ambient `prepare`, `submit`, and `get`.
Generic result types are caller annotations; the SDK validates the execution envelope,
not individual capability DTOs.

Prepare creates a frozen JSON snapshot, key and normalized Core base URL, with no network
request or credentials. The descriptor can be serialized and restored. Submit uses the
same body, key and capability for at most three attempts (network failure or HTTP
502/503/504), within 30 seconds. Individual requests, including reading their bodies,
are capped at 15 seconds. Admission-disabled, auth, conflict, expired and malformed
responses stop immediately. There is no synchronous fallback or read-by-key endpoint.
After a lost receipt, resubmit the original descriptor under the same owner/trusted run.

New HTTP 202 and replay HTTP 200 both return receipts, even when terminal. Retrieve an
outcome separately. Pending states have no result. A successful result may be null.
Logical failure/indeterminate states are HTTP 200 outcomes; HTTP errors retain their
actual status. Saved confirmed failures are classified as invalid_request=400,
rate_limited/capability_usage_limit=429, deadline_exceeded=504, execution_failed=502.
These SDK classifications do not reconstruct original provider HTTP responses.
Indeterminate outcomes must not be automatically resubmitted. HTTP 410 means the saved
payload expired, and does not authorize another execution under the same key.

The saved Core base must equal the currently configured base before resubmission.
Resolution is explicit call option, client coreBaseUrl, SAPIOM_BASE_URL,
SAPIOM_API_URL, then https://api.sapiom.ai. HTTP(S) bases may have a path prefix but
cannot contain userinfo, query or fragment. All request paths are built locally;
receipt/Location URLs are ignored and redirects are rejected. A raw execution ID
requires the caller to configure the original backend. Credentials are never refreshed
implicitly: resume using credentials for the same stable token family or API-key owner.

Errors carry available executionId/submissionKey. Persisting caller state is the caller's
responsibility. Request and credential contents are never included in error messages.

`await client.executions.wait<T>(handle)` returns the saved result or throws a typed
ExecutionFailedError/ExecutionIndeterminateError. Pass a serialized handle on a fresh
client to retain origin checks; raw IDs require the original backend configuration.
Wait only issues GET. After losing a receipt, submit the original descriptor first.
It defaults to a five-minute local budget, 500 ms initial polling and exponential
backoff with jitter capped at five seconds. Transient network and 429/502/503/504
responses are retried within that budget. Retry-After is capped by remaining time.
Override waitTimeoutMs, initialPollIntervalMs, maxPollIntervalMs or requestTimeoutMs
with finite positive durations. Each request is bounded by remaining time and 15 seconds.
AbortSignal or local timeout throws ExecutionWaitInterruptedError with ID/key. It stops
only local waiting; the server job continues. Persist handles in caller-owned storage.
The offline stub supports preparation but rejects durable submission/retrieval explicitly.

`capabilityDelivery: "executions"` opts the common capability helper into job delivery
only for capabilities on its reviewed allow-list: search, scrape, the three email lookups,
image/video submissions, the four memory operations, database creation, domain registration,
and upload reservations (14 capability IDs). `decisions.evaluate` remains inline because its
streamed metering needs separate adoption. The default is `legacy`, and Core admission is
still disabled pending the release gate. A selected invocation
keeps its mode, Core base and key through retries; admission rejection never falls back
to the synchronous path. Existing namespace mappers receive the stored raw result, including
native media launch handles; generation polling and finalization retain their owners.

For memory and provisioning, the common helper selects the existing gateway callback before
any I/O in legacy mode. Gateway URL overrides apply to that callback; execution delivery uses
the configured Core origin. Existing database/domain/file lifecycle methods stay unchanged.

Inputs and ordinary results have a 1 MiB protected JSON limit (input authorization metadata
counts toward that limit). Memory recall accepts up to 10 MiB of protected output. A legal
search/scrape result larger than its storage bound can become indeterminate after dispatch;
it is never truncated or automatically rerun. Execution retention does not renew a native
handle or upload URL: replay returns the original reservation, including its original expiry.
Saved failures use sanitized execution codes mapped to namespace HTTP errors. They do not
preserve arbitrary upstream error bodies. Indeterminate, expired-result and interrupted-wait
errors remain distinct and carry execution/submission references for recovery.

Execution HTTP requests emit `capability.execution.transport`, not `capability.call`.
An observed terminal outcome emits `capability.call` with execution_status and logical ok;
HTTP 200 failed/indeterminate is not success. Attributed views of one client share a
completion cache (origin/ID, at most 1000 entries for one hour, oldest entry evicted).
Independent clients, processes and evicted entries can report the outcome again. Server
execution/billing records remain authoritative. Interrupted waits have their own observation
event and are not logical provider failures. Telemetry stays best-effort and respects opt-out.
