/**
 * Shared test helpers. This file is intentionally not matched by
 * `testMatch` (only *.test.ts / *.spec.ts are test suites).
 */
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

import type {
  Envelope,
  FetchLike,
  FetchRequestInit,
  SapiomAnalytics,
} from "../types.js";

export const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TempHome {
  dir: string;
  identityPath: string;
  restore(): void;
}

/**
 * Redirect the identity store to a fresh temp home dir (simulates a separate
 * machine/process). The store resolves its location from `HOME`/`USERPROFILE`,
 * which works under jest where `process.env` mutations never reach the
 * native environ that `os.homedir()` reads.
 */
export function useTempHome(): TempHome {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sapiom-analytics-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;

  // Tripwire: fail loudly if a test ever escapes the sandbox and touches the
  // real ~/.sapiom/analytics.json instead of the temp one.
  const realIdentityPath = path.join(os.homedir(), ".sapiom", "analytics.json");
  const realIdentityBefore = readFileOrNull(realIdentityPath);

  return {
    dir,
    identityPath: path.join(dir, ".sapiom", "analytics.json"),
    restore() {
      restoreEnvVar("HOME", previousHome);
      restoreEnvVar("USERPROFILE", previousUserProfile);
      fs.rmSync(dir, { recursive: true, force: true });
      if (readFileOrNull(realIdentityPath) !== realIdentityBefore) {
        throw new Error(
          `test escaped the temp HOME sandbox and modified ${realIdentityPath}`,
        );
      }
    },
  };
}

function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Clear consent/endpoint env vars for the duration of a test; returns a restore fn. */
export function cleanAnalyticsEnv(): () => void {
  const keys = [
    "SAPIOM_TELEMETRY_DISABLED",
    "DO_NOT_TRACK",
    "SAPIOM_ANALYTICS_ENDPOINT",
  ];
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return () => {
    for (const key of keys) restoreEnvVar(key, saved[key]);
  };
}

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

export interface CapturedCall {
  url: string;
  init: FetchRequestInit;
}

export interface CapturingFetch {
  calls: CapturedCall[];
  fetchImpl: FetchLike;
  /** Events of the nth captured batch. */
  batch(index?: number): Envelope[];
}

export interface CapturingFetchOptions {
  /** Single status for all calls, or a sequence (last one repeats). */
  status?: number | number[];
  /** Resolve after this many ms (slow collector). */
  delayMs?: number;
  /** Reject every call (network failure / collector down). */
  reject?: boolean;
}

export function createCapturingFetch(
  options: CapturingFetchOptions = {},
): CapturingFetch {
  const calls: CapturedCall[] = [];
  const statusSequence = Array.isArray(options.status)
    ? [...options.status]
    : undefined;

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url: String(url), init });
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    if (options.reject) {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), {
        code: "ECONNREFUSED",
      });
    }
    const status = statusSequence
      ? statusSequence.length > 1
        ? (statusSequence.shift() as number)
        : statusSequence[0]
      : ((options.status as number | undefined) ?? 202);
    return { ok: status >= 200 && status < 300, status };
  };

  return {
    calls,
    fetchImpl,
    batch(index = 0) {
      const call = calls[index];
      if (!call) throw new Error(`no captured fetch call at index ${index}`);
      return JSON.parse(call.init.body).events as Envelope[];
    },
  };
}

/** Find a local port with nothing listening on it (for real ECONNREFUSED). */
export function getClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/** Track created instances so afterEach can shut them all down. */
export function instanceTracker(): {
  register: <T extends SapiomAnalytics>(instance: T) => T;
  shutdownAll: () => Promise<void>;
} {
  const instances: SapiomAnalytics[] = [];
  return {
    register(instance) {
      instances.push(instance);
      return instance;
    },
    async shutdownAll() {
      await Promise.all(instances.splice(0).map((i) => i.shutdown()));
    },
  };
}
