import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface IngestCredentialProvider {
  /** Issues a new opaque capability and invalidates any prior one for this id. */
  issue(sessionId: string): string;
  authenticate(sessionId: string, token: string): boolean;
  revoke(sessionId: string): void;
}

const EMPTY_DIGEST = Buffer.alloc(32);

function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Process-local, session-bound ingest capabilities. Only token digests are
 * retained, so neither session records nor accidental object serialization
 * can disclose a credential. PTYs do not survive a server restart, therefore
 * the registry intentionally does not persist.
 */
export class IngestCredentialRegistry implements IngestCredentialProvider {
  private readonly digests = new Map<string, Buffer>();

  constructor(
    private readonly generateToken: () => string = () =>
      randomBytes(32).toString("base64url"),
  ) {}

  issue(sessionId: string): string {
    if (!sessionId) throw new Error("ingest credential requires a session id");
    const token = this.generateToken();
    if (!token || token.length > 512) {
      throw new Error("invalid generated ingest credential");
    }
    this.digests.set(sessionId, digest(token));
    return token;
  }

  authenticate(sessionId: string, token: string): boolean {
    if (!sessionId || !token || token.length > 512) return false;
    const expected = this.digests.get(sessionId);
    const matches = timingSafeEqual(expected ?? EMPTY_DIGEST, digest(token));
    return expected !== undefined && matches;
  }

  revoke(sessionId: string): void {
    this.digests.delete(sessionId);
  }
}
