import { createHash } from "node:crypto";
import {
  resolveEnvironment,
  readCredentialsOrThrow,
  type ResolvedEnvironment,
} from "@sapiom/mcp/auth";
import { refreshStudioCredentials } from "./studio-credentials.js";

/** Private host state. Only `enabled` is projected to the browser. */
export interface AssistantGrant {
  userId: string;
  tenantId: string;
  identityRevision: string;
  expiresAt: number;
  environment: ResolvedEnvironment;
}

interface CapabilityResponse {
  protocol?: number;
  assistant?: boolean;
  userId?: string;
  tenantId?: string;
  identityRevision?: string;
  maxAgeMs?: number;
  refreshAfterMs?: number;
}

export interface AssistantAccessOptions {
  enabled: boolean;
  harnessVersion: string;
  getApiKey: () => string | null;
  environment?: string;
  loadEnvironment?: () => Promise<ResolvedEnvironment>;
  refreshCredentials?: typeof refreshStudioCredentials;
  fetch?: typeof globalThis.fetch;
}

const fingerprint = (env: ResolvedEnvironment): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        env.name,
        env.apiURL,
        env.services,
        env.credentials?.apiKey,
        env.credentials?.tenantId,
      ]),
    )
    .digest("hex");

/** Bounded, revocable eligibility; no analytics opt-in or persisted enabled cache. */
export class AssistantAccess {
  private grant: AssistantGrant | null = null;
  private credentialFingerprint: string | null = null;
  private epoch = 0;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();

  constructor(private readonly options: AssistantAccessOptions) {}

  get(): AssistantGrant | null {
    if (
      this.grant &&
      (this.grant.expiresAt <= Date.now() ||
        this.options.getApiKey() !== this.grant.environment.credentials?.apiKey)
    )
      this.adopt(null);
    return this.grant;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.epoch++;
    this.credentialFingerprint = null;
    this.adopt(null);
  }

  refresh(): Promise<void> {
    if (this.closed || !this.options.enabled) return Promise.resolve();
    // A newer credential observation fences any older response, without
    // revoking a running grant just because another host rotated its token.
    const epoch = ++this.epoch;
    const run = this.queue.then(() => this.evaluate(epoch));
    this.queue = run.catch(() => {
      this.adopt(null);
    });
    return this.queue;
  }

  close(): void {
    this.closed = true;
    this.clear();
    clearTimeout(this.refreshTimer);
    this.listeners.clear();
  }

  private adopt(grant: AssistantGrant | null): void {
    const changed =
      this.grant?.identityRevision !== grant?.identityRevision ||
      this.grant?.environment.name !== grant?.environment.name ||
      this.grant?.environment.apiURL !== grant?.environment.apiURL ||
      this.grant?.environment.credentials?.apiKey !==
        grant?.environment.credentials?.apiKey;
    this.grant = grant;
    clearTimeout(this.expiryTimer);
    if (grant) {
      this.expiryTimer = setTimeout(
        () => this.adopt(null),
        Math.max(0, grant.expiresAt - Date.now()),
      );
      this.expiryTimer.unref?.();
    }
    if (changed) for (const listener of this.listeners) listener();
  }

  private async evaluate(epoch: number): Promise<void> {
    if (this.closed || epoch !== this.epoch) return;
    clearTimeout(this.refreshTimer);
    let refreshAfterMs = 30_000;
    const current = () => !this.closed && epoch === this.epoch;
    try {
      const env = this.options.loadEnvironment
        ? await this.options.loadEnvironment()
        : await resolveEnvironment(
            this.options.environment ?? process.env.SAPIOM_ENVIRONMENT,
          );
      if (!this.options.loadEnvironment)
        env.credentials = await readCredentialsOrThrow(env.name);
      if (!current()) return;
      const before = fingerprint(env);
      if (before !== this.credentialFingerprint) this.adopt(null);
      this.credentialFingerprint = before;
      if (
        !env.credentials?.studioCredentials ||
        !env.credentials.apiKey ||
        env.credentials.apiKey !== this.options.getApiKey()
      ) {
        this.adopt(null);
        return;
      }
      const credentials = await (
        this.options.refreshCredentials ?? refreshStudioCredentials
      )(env);
      if (!current()) return;
      if (!credentials) {
        this.adopt(null);
        return;
      }
      env.credentials = { ...env.credentials, studioCredentials: credentials };
      const startedAt = Date.now();
      const response = await (this.options.fetch ?? fetch)(
        `${env.apiURL}/v1/studio/capabilities`,
        {
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "X-Studio-Capability-Version": "1",
            "X-Studio-Harness-Version": this.options.harnessVersion,
          },
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        },
      );
      if (!current()) return;
      if (!response.ok) {
        this.adopt(null);
        return;
      }
      const result = (await response.json()) as CapabilityResponse;
      if (!current()) return;
      if (
        result.protocol !== 1 ||
        result.assistant !== true ||
        typeof result.userId !== "string" ||
        !result.userId ||
        typeof result.identityRevision !== "string" ||
        !result.identityRevision ||
        result.tenantId !== env.credentials.tenantId ||
        typeof result.maxAgeMs !== "number" ||
        !Number.isFinite(result.maxAgeMs) ||
        result.maxAgeMs <= 0
      ) {
        this.adopt(null);
        return;
      }
      const expiresAt = Math.min(
        startedAt + Math.min(result.maxAgeMs, 60_000),
        Date.parse(credentials.expiresAt),
      );
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        this.adopt(null);
        return;
      }
      this.credentialFingerprint = fingerprint(env);
      this.adopt({
        userId: result.userId,
        tenantId: result.tenantId,
        identityRevision: result.identityRevision,
        expiresAt,
        environment: env,
      });
      if (
        typeof result.refreshAfterMs === "number" &&
        Number.isFinite(result.refreshAfterMs)
      )
        refreshAfterMs = Math.max(
          1000,
          Math.min(result.refreshAfterMs, 30_000),
        );
    } catch {
      if (current()) this.adopt(null);
    } finally {
      if (current()) {
        this.refreshTimer = setTimeout(() => {
          void this.refresh();
        }, refreshAfterMs);
        this.refreshTimer.unref?.();
      }
    }
  }
}
