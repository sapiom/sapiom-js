import { createHash, randomBytes } from "node:crypto";

import type { ProjectAgentSession } from "../shared/agent-map.js";

export type AgentMapCapabilityRejection =
  | "invalid_capability"
  | "expired_capability"
  | "revoked_capability";

export class AgentMapCapabilityError extends Error {
  constructor(readonly code: AgentMapCapabilityRejection) {
    super("Agent Map capability is not valid");
    this.name = "AgentMapCapabilityError";
  }
}

export interface ResolvedAgentMapCapability {
  identity: ProjectAgentSession;
  generation: number;
  expiresAt: number;
}

export interface IssuedAgentMapCapability extends ResolvedAgentMapCapability {
  token: string;
}

export interface AgentMapCapabilityEvent {
  name:
    | "agent_map.capability.issued"
    | "agent_map.capability.rotated"
    | "agent_map.capability.revoked"
    | "agent_map.capability.rejected";
  reason?: AgentMapCapabilityRejection;
}

export interface AgentMapCapabilityRegistryOptions {
  ttlMs?: number;
  now?: () => number;
  randomToken?: () => string;
  onEvent?: (event: AgentMapCapabilityEvent) => void;
}

interface Entry extends ResolvedAgentMapCapability {
  digest: string;
}

/** Drop any legacy role/assignment properties before they enter authority. */
const neutralPrincipal = (
  identity: ProjectAgentSession,
): ProjectAgentSession => ({
  projectId: identity.projectId,
  userId: identity.userId,
  sessionId: identity.sessionId,
});

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_REVOKED_DIGESTS = 4_096;

/** Process-local, digest-only authority for the embedded Agent Map MCP. */
export class AgentMapCapabilityRegistry {
  private readonly active = new Map<string, Entry>();
  private readonly currentBySession = new Map<string, string>();
  private readonly revoked = new Set<string>();
  private readonly generations = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly randomToken: () => string;

  constructor(
    private readonly options: AgentMapCapabilityRegistryOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.randomToken =
      options.randomToken ?? (() => randomBytes(32).toString("base64url"));
  }

  issue(identity: ProjectAgentSession): IssuedAgentMapCapability {
    const principal = neutralPrincipal(identity);
    this.revokeSession(principal.sessionId);
    const token = this.randomToken();
    const digest = this.digest(token);
    if (!token || this.active.has(digest) || this.revoked.has(digest)) {
      throw new AgentMapCapabilityError("invalid_capability");
    }
    const generation = (this.generations.get(principal.sessionId) ?? 0) + 1;
    this.generations.set(principal.sessionId, generation);
    const entry: Entry = {
      digest,
      identity: principal,
      generation,
      expiresAt: this.now() + this.ttlMs,
    };
    this.active.set(digest, entry);
    this.currentBySession.set(principal.sessionId, digest);
    this.emit({ name: "agent_map.capability.issued" });
    return { token, ...this.publicEntry(entry) };
  }

  rotate(identity: ProjectAgentSession): IssuedAgentMapCapability {
    this.revokeSession(identity.sessionId);
    const issued = this.issue(identity);
    this.emit({ name: "agent_map.capability.rotated" });
    return issued;
  }

  resolve(token: string): ResolvedAgentMapCapability {
    const digest = this.digest(token);
    const entry = this.active.get(digest);
    if (!entry) {
      const reason = this.revoked.has(digest)
        ? "revoked_capability"
        : "invalid_capability";
      this.reject(reason);
    }
    const resolvedAt = this.now();
    if (entry.expiresAt <= resolvedAt) {
      this.active.delete(digest);
      this.currentBySession.delete(entry.identity.sessionId);
      this.revoked.add(digest);
      this.pruneRevoked();
      this.reject("expired_capability");
    }
    // This is an inactivity lease, not a scheduled outage for a live agent.
    // Successful authenticated use keeps the same private token viable while
    // exit, principal change, resume rotation, and explicit revocation remain
    // hard lifecycle boundaries.
    entry.expiresAt = resolvedAt + this.ttlMs;
    return this.publicEntry(entry);
  }

  revokeSession(sessionId: string): void {
    const digest = this.currentBySession.get(sessionId);
    if (!digest) return;
    this.active.delete(digest);
    this.currentBySession.delete(sessionId);
    this.revoked.add(digest);
    this.pruneRevoked();
    this.emit({ name: "agent_map.capability.revoked" });
  }

  isGenerationLive(sessionId: string, generation: number): boolean {
    const digest = this.currentBySession.get(sessionId);
    const entry = digest ? this.active.get(digest) : undefined;
    return (
      !!entry && entry.generation === generation && entry.expiresAt > this.now()
    );
  }

  private publicEntry(entry: Entry): ResolvedAgentMapCapability {
    return {
      identity: structuredClone(entry.identity),
      generation: entry.generation,
      expiresAt: entry.expiresAt,
    };
  }

  private digest(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  private reject(reason: AgentMapCapabilityRejection): never {
    this.emit({ name: "agent_map.capability.rejected", reason });
    throw new AgentMapCapabilityError(reason);
  }

  private pruneRevoked(): void {
    while (this.revoked.size > MAX_REVOKED_DIGESTS) {
      const oldest = this.revoked.values().next().value as string | undefined;
      if (!oldest) break;
      this.revoked.delete(oldest);
    }
  }

  private emit(event: AgentMapCapabilityEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // Bounded observability must never change authorization semantics.
    }
  }
}
