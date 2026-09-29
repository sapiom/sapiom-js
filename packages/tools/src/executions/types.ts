/** Version 1 matches Core's capability-execution API; local metadata stays off the wire. */
export type ExecutionStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "indeterminate";
export interface ExecutionReceipt {
  readonly version: 1;
  readonly id: string;
  readonly capabilityId: string;
  readonly status: ExecutionStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
}
export interface ExecutionSubmission {
  readonly version: 1;
  readonly capabilityId: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly submissionKey: string;
  readonly coreBaseUrl: string;
}
export interface ExecutionHandle {
  readonly receipt: ExecutionReceipt;
  readonly submissionKey: string;
  readonly coreBaseUrl: string;
}
export interface ExecutionErrorBody {
  readonly code:
    | "invalid_request"
    | "rate_limited"
    | "capability_usage_limit"
    | "deadline_exceeded"
    | "execution_failed"
    | "execution_indeterminate";
  readonly message: string;
}
export type ExecutionState<T = unknown> = ExecutionReceipt &
  (
    | { readonly status: "queued" | "running" }
    | { readonly status: "succeeded"; readonly result: T }
    | {
        readonly status: "failed" | "indeterminate";
        readonly error: ExecutionErrorBody;
      }
  );
/** Credentials and request bodies are deliberately absent from resumable errors. */
export interface ExecutionReference {
  readonly executionId?: string;
  readonly submissionKey?: string;
}
