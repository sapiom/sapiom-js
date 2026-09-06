import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface IngestCredentialProvider {
  /** Issues a new opaque capability/runtime epoch and invalidates any prior one. */
  issue(sessionId: string): IssuedIngestCredential;
  /** Returns the server-owned runtime epoch for this exact capability. */
  authenticate(sessionId: string, token: string): string | null;
  revoke(sessionId: string): void;
}

export interface IssuedIngestCredential {
  token: string;
  /** Opaque process-local identity for the PTY generation receiving `token`. */
  runtimeEpoch: string;
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
  private readonly credentials = new Map<
    string,
    { digest: Buffer; runtimeEpoch: string }
  >();

  constructor(
    private readonly generateToken: () => string = () =>
      randomBytes(32).toString("base64url"),
    private readonly generateRuntimeEpoch: () => string = () =>
      randomBytes(16).toString("base64url"),
  ) {}

  issue(sessionId: string): IssuedIngestCredential {
    if (!sessionId) throw new Error("ingest credential requires a session id");
    const token = this.generateToken();
    if (!token || token.length > 512) {
      throw new Error("invalid generated ingest credential");
    }
    const runtimeEpoch = this.generateRuntimeEpoch();
    if (!runtimeEpoch || runtimeEpoch.length > 128) {
      throw new Error("invalid generated ingest runtime epoch");
    }
    this.credentials.set(sessionId, { digest: digest(token), runtimeEpoch });
    return { token, runtimeEpoch };
  }

  authenticate(sessionId: string, token: string): string | null {
    if (!sessionId || !token || token.length > 512) return null;
    const expected = this.credentials.get(sessionId);
    const matches = timingSafeEqual(
      expected?.digest ?? EMPTY_DIGEST,
      digest(token),
    );
    return expected !== undefined && matches ? expected.runtimeEpoch : null;
  }

  revoke(sessionId: string): void {
    this.credentials.delete(sessionId);
  }
}
