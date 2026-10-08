import { randomUUID } from "node:crypto";
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
  "access_denied" | "authentication_required" | "transport_unavailable"
>;

/**
 * Who the Assistant runs as. The bridge forwards with this environment's API
 * key, which already authorizes every model call it makes; this record only
 * decides whether Studio shows the Assistant.
 */
export interface AssistantGrant {
  userId: string;
  tenantId: string;
  environment: ResolvedEnvironment;
}

/** Browser-safe access state. The revision changes only with the account. */
export interface AssistantAccessProjection {
  enabled: boolean;
  authorityRevision: string;
}

export interface AssistantAccessOptions {
  enabled: boolean;
  harnessVersion: string;
  getApiKey: () => string | null;
  environment?: string;
  loadEnvironment?: () => Promise<ResolvedEnvironment>;
  refreshCredentials?: typeof refreshStudioCredentials;
  fetch?: typeof globalThis.fetch;
  /** How often the PostHog kill switch is re-read. */
  refreshIntervalMs?: number;
}

const REFRESH_INTERVAL_MS = 5 * 60_000;

/** Same account and key: running Assistant hosts may keep going. */
export const samePrincipal = (a: AssistantGrant, b: AssistantGrant): boolean =>
  a.userId === b.userId &&
  a.tenantId === b.tenantId &&
  a.environment.name === b.environment.name &&
  a.environment.apiURL === b.environment.apiURL &&
  a.environment.credentials?.apiKey === b.environment.credentials?.apiKey;

/**
 * Whether the signed-in Studio account has the Assistant: asked of
 * `/v1/studio/capabilities` at boot, on every credential change, and every
 * five minutes so turning the flag off takes effect without a restart. A
 * network or 5xx failure keeps the last answer.
 */
export class AssistantAccess {
  private grant: AssistantGrant | null = null;
  private failure: AssistantAccessFailureCode = this.options.enabled
    ? "authentication_required"
    : "access_denied";
  private authorityRevision = randomUUID();
  private generation = 0;
  private closed = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();

  constructor(private readonly options: AssistantAccessOptions) {}

  get(): AssistantGrant | null {
    // A key rotated by another Studio window is a different principal.
    if (
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

  getBrowserState(): AssistantAccessProjection {
    return {
      enabled: this.get() !== null,
      authorityRevision: this.authorityRevision,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.generation++;
    this.adopt(null, "authentication_required");
  }

  async refresh(): Promise<void> {
    if (this.closed || !this.options.enabled) return;
    clearTimeout(this.refreshTimer);
    // A newer check (a sign-in, a credential write) supersedes an older one.
    const generation = ++this.generation;
    // Scheduled before awaiting, so a check that never settles cannot stop
    // the next one from applying the flag.
    this.refreshTimer = setTimeout(
      () => void this.refresh(),
      this.options.refreshIntervalMs ?? REFRESH_INTERVAL_MS,
    );
    this.refreshTimer.unref?.();
    const result = await this.check().catch(
      (): CheckResult => ({ failure: "access_denied" }),
    );
    if (this.closed || generation !== this.generation) return;
    if ("grant" in result) this.adopt(result.grant);
    else if (result.failure !== "transport_unavailable" || !this.grant)
      this.adopt(null, result.failure);
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
      !!grant !== !!this.grant ||
      (grant !== null && this.grant !== null && !samePrincipal(grant, this.grant));
    if (changed) this.authorityRevision = randomUUID();
    this.grant = grant;
    this.failure = failure;
    if (changed) for (const listener of this.listeners) listener();
  }

  private async check(): Promise<CheckResult> {
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
      return { failure: "access_denied" };
    }
    if (
      !env.credentials?.studioCredentials ||
      !env.credentials.apiKey ||
      env.credentials.apiKey !== this.options.getApiKey()
    )
      return { failure: "authentication_required" };
    let credentials;
    try {
      credentials = await (
        this.options.refreshCredentials ?? refreshStudioCredentials
      )(env);
    } catch (error) {
      return {
        failure:
          error instanceof StudioCredentialRefreshError &&
          error.kind === "transient"
            ? "transport_unavailable"
            : "authentication_required",
      };
    }
    if (!credentials) return { failure: "authentication_required" };
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
      return { failure: "transport_unavailable" };
    }
    if (response.status >= 500) return { failure: "transport_unavailable" };
    if (response.status === 401 || response.status === 403)
      return { failure: "authentication_required" };
    const result = (await response.json().catch(() => null)) as {
      assistant?: unknown;
      userId?: unknown;
      tenantId?: unknown;
    } | null;
    if (
      !response.ok ||
      result?.assistant !== true ||
      typeof result.userId !== "string" ||
      !result.userId ||
      result.tenantId !== env.credentials.tenantId
    )
      return { failure: "access_denied" };
    return {
      grant: {
        userId: result.userId,
        tenantId: env.credentials.tenantId,
        environment: {
          ...env,
          credentials: { ...env.credentials, studioCredentials: credentials },
        },
      },
    };
  }
}

type CheckResult =
  | { grant: AssistantGrant }
  | { failure: AssistantAccessFailureCode };
