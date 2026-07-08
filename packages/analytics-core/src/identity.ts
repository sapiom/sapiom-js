import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { DebugHook } from "./types.js";

export interface IdentityRecord {
  anonymous_id: string;
  first_run_notice_at: string | null;
}

/**
 * Persistent anonymous identity at `~/.sapiom/analytics.json` (mode 0600).
 *
 * - Created lazily, on first use — never at import time, never when disabled.
 * - A corrupt or unreadable file is silently regenerated.
 * - When the file cannot be read or written at all (e.g. unwritable HOME),
 *   every method degrades to `null`/`false` and the caller carries on with
 *   an anonymous_id of `null`.
 */
export class IdentityStore {
  private cached: IdentityRecord | null = null;
  private unavailable = false;

  constructor(private readonly debug: DebugHook) {}

  /** Load the identity record, creating it if needed. `null` when persistence is impossible. */
  load(): IdentityRecord | null {
    if (this.cached) return this.cached;
    if (this.unavailable) return null;
    try {
      const filePath = this.identityFilePath();
      let record = this.readRecord(filePath);
      if (!record) {
        record = { anonymous_id: randomUUID(), first_run_notice_at: null };
        this.writeRecord(filePath, record);
      }
      this.cached = record;
      return record;
    } catch (error) {
      this.debug("identity store unavailable", error);
      this.unavailable = true;
      return null;
    }
  }

  /**
   * Stamp `first_run_notice_at` if it has never been stamped.
   * Returns `true` only for the call that performed the transition — i.e.
   * the caller that should print the first-run notice.
   */
  markFirstRunNoticeShown(): boolean {
    try {
      const record = this.load();
      if (!record || record.first_run_notice_at) return false;
      record.first_run_notice_at = new Date().toISOString();
      this.writeRecord(this.identityFilePath(), record);
      return true;
    } catch (error) {
      this.debug("failed to persist first-run notice marker", error);
      return false;
    }
  }

  private identityFilePath(): string {
    return path.join(resolveHomeDir(), ".sapiom", "analytics.json");
  }

  /** Read + validate. Any corruption yields `null` so the caller regenerates. */
  private readRecord(filePath: string): IdentityRecord | null {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        typeof (parsed as IdentityRecord).anonymous_id === "string" &&
        (parsed as IdentityRecord).anonymous_id.length > 0
      ) {
        const noticeAt = (parsed as IdentityRecord).first_run_notice_at;
        return {
          anonymous_id: (parsed as IdentityRecord).anonymous_id,
          first_run_notice_at: typeof noticeAt === "string" ? noticeAt : null,
        };
      }
      return null;
    } catch {
      // Missing or corrupt — regenerate.
      return null;
    }
  }

  private writeRecord(filePath: string, record: IdentityRecord): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + "\n", {
      mode: 0o600,
    });
    try {
      // `mode` only applies on creation; keep pre-existing files private too.
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Best effort.
    }
  }
}

/**
 * Prefer the HOME/USERPROFILE environment variables over `os.homedir()`:
 * identical in normal operation (`os.homedir()` consults them anyway), but
 * it keeps the location overridable in sandboxed environments where
 * `process.env` mutations never reach the native environ.
 */
function resolveHomeDir(): string {
  const fromEnv = process.env.HOME || process.env.USERPROFILE;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return os.homedir();
}
