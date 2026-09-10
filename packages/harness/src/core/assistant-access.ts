import { createHash } from "node:crypto";
import {
  resolveEnvironment,
  readCredentialsOrThrow,
  type ResolvedEnvironment,
} from "@sapiom/mcp/auth";
import {
  refreshStudioCredentials,
  StudioCredentialRefreshError,
} from "./studio-credentials.js";
import type { OpenCodeTransportErrorCode } from "../shared/opencode-errors.js";

export type AssistantAccessFailureCode = Extract<
  OpenCodeTransportErrorCode,
  | "access_denied"
  | "access_expired"
  | "authentication_required"
  | "transport_unavailable"
>;

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
  private failure: AssistantAccessFailureCode = this.options.enabled
    ? "authentication_required"
    : "access_denied";
  private credentialFingerprint: string | null = null;
  private epoch = 0;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();

  constructor(private readonly options: AssistantAccessOptions) {}

  get(): AssistantGrant | null {
    if (this.grant?.expiresAt && this.grant.expiresAt <= Date.now())
      this.adopt(null, "access_expired");
    else if (
      this.grant &&
      this.options.getApiKey() !== this.grant.environment.credentials?.apiKey
    )
      this.adopt(null, "authentication_required");
    return this.grant;
  }

  getFailureCode(): AssistantAccessFailureCode {
    this.get();
    return this.failure;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.epoch++;
    this.credentialFingerprint = null;
    this.adopt(null, "authentication_required");
  }

  refresh(): Promise<void> {
    if (this.closed || !this.options.enabled) return Promise.resolve();
    // A newer credential observation fences any older response, without
    // revoking a running grant just because another host rotated its token.
    const epoch = ++this.epoch;
    const run = this.queue.then(() => this.evaluate(epoch));
    this.queue = run.catch(() => {
      if (!this.closed && epoch === this.epoch)
        this.adopt(null, "access_denied");
    });
    return this.queue;
  }

  close(): void {
    this.closed = true;
    this.clear();
    clearTimeout(this.refreshTimer);
    this.listeners.clear();
  }

  private adopt(
    grant: AssistantGrant | null,
    failure: AssistantAccessFailureCode = this.failure,
  ): void {
    const changed =
      this.grant?.identityRevision !== grant?.identityRevision ||
      this.grant?.environment.name !== grant?.environment.name ||
      this.grant?.environment.apiURL !== grant?.environment.apiURL ||
      this.grant?.environment.credentials?.apiKey !==
        grant?.environment.credentials?.apiKey;
    this.grant = grant;
    this.failure = failure;
    clearTimeout(this.expiryTimer);
    if (grant) {
      this.expiryTimer = setTimeout(
        () => this.adopt(null, "access_expired"),
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
      let env: ResolvedEnvironment;
      try {
        env = this.options.loadEnvironment
          ? await this.options.loadEnvironment()
          : await resolveEnvironment(
              this.options.environment ?? process.env.SAPIOM_ENVIRONMENT,
            );
        if (!this.options.loadEnvironment)
          env.credentials = await readCredentialsOrThrow(env.name);
      } catch {
        if (current()) this.adopt(null, "access_denied");
        return;
      }
      if (!current()) return;
      const before = fingerprint(env);
      if (
        this.credentialFingerprint !== null &&
        before !== this.credentialFingerprint
      )
        this.adopt(null, "access_denied");
      this.credentialFingerprint = before;
      if (
        !env.credentials?.studioCredentials ||
        !env.credentials.apiKey ||
        env.credentials.apiKey !== this.options.getApiKey()
      ) {
        this.adopt(null, "authentication_required");
        return;
      }
      const observedCredentialExpiry = Date.parse(
        env.credentials.studioCredentials.expiresAt,
      );
      if (
        !Number.isFinite(observedCredentialExpiry) ||
        observedCredentialExpiry <= Date.now()
      ) {
        this.adopt(null, "authentication_required");
        return;
      }
      let credentials;
      try {
        credentials = await (
          this.options.refreshCredentials ?? refreshStudioCredentials
        )(env);
      } catch (error) {
        if (!current()) return;
        if (
          error instanceof StudioCredentialRefreshError &&
          error.kind === "transient"
        )
          this.retainTransient(before, observedCredentialExpiry);
        else this.adopt(null, "authentication_required");
        return;
      }
      if (!current()) return;
      if (!credentials) {
        this.adopt(null, "authentication_required");
        return;
      }
      const credentialExpiry = Date.parse(credentials.expiresAt);
      if (
        !Number.isFinite(credentialExpiry) ||
        credentialExpiry <= Date.now()
      ) {
        this.adopt(null, "authentication_required");
        return;
      }
      env.credentials = { ...env.credentials, studioCredentials: credentials };
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(
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
      } catch {
        if (current()) this.retainTransient(before, credentialExpiry);
        return;
      }
      if (!current()) return;
      if (!response.ok) {
        if (response.status >= 500)
          this.retainTransient(before, credentialExpiry);
        else
          this.adopt(
            null,
            [401, 403].includes(response.status)
              ? "authentication_required"
              : "access_denied",
          );
        return;
      }
      let result: CapabilityResponse;
      try {
        result = (await response.json()) as CapabilityResponse;
      } catch {
        this.adopt(null, "access_denied");
        return;
      }
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
        this.adopt(null, "access_denied");
        return;
      }
      const expiresAt = Math.min(
        startedAt + Math.min(result.maxAgeMs, 60_000),
        credentialExpiry,
      );
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        this.adopt(null, "authentication_required");
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
      if (current()) this.adopt(null, "access_denied");
    } finally {
      if (current()) {
        this.refreshTimer = setTimeout(() => {
          void this.refresh();
        }, refreshAfterMs);
        this.refreshTimer.unref?.();
      }
    }
  }

  private retainTransient(
    fingerprintAtFailure: string,
    credentialExpiry: number,
  ): void {
    const grant = this.get();
    if (!grant) {
      if (this.failure !== "access_denied" && this.failure !== "access_expired")
        this.adopt(null, "transport_unavailable");
      return;
    }
    if (
      this.credentialFingerprint !== fingerprintAtFailure ||
      credentialExpiry <= Date.now() ||
      grant.environment.credentials?.apiKey !== this.options.getApiKey()
    )
      this.adopt(null, "transport_unavailable");
  }
}
