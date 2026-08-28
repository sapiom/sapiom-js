/**
 * Orders every HTTP response that can replace the browser's workflow
 * projection. Boot, bus-driven refreshes, auth refreshes, scans, connects, and
 * deploy refreshes all share this clock, so an older response can never put a
 * row back after a newer successful request observed its removal.
 *
 * A merely-started request does not invalidate an older success. That detail
 * lets boot remain a safe fallback when a newer bus/auth refresh fails: the
 * successful response with the greatest request id wins, independent of
 * completion order.
 */
export class WorkflowProjectionOrder<T> {
  private issued = 0;
  private acceptedRequest = 0;
  private accepted: readonly T[] | null = null;

  begin(): number {
    this.issued += 1;
    return this.issued;
  }

  /** Accepts `rows` unless a newer request already committed successfully. */
  accept(request: number, rows: readonly T[]): boolean {
    if (request < this.acceptedRequest) return false;
    this.acceptedRequest = request;
    this.accepted = rows;
    return true;
  }

  /** The last monotonic projection, if any request has committed one. */
  current(): readonly T[] | null {
    return this.accepted;
  }
}
