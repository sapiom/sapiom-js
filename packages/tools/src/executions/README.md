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
