import {
  listSchedules,
  type DefinitionSummary,
  type GatewayClient,
} from "@sapiom/agent-core";

import type { Evaluate } from "./labels.js";
import type { PlatformSource } from "./scan-project.js";
import type { DescribedTrigger } from "./types.js";

const PLATFORM_TTL_MS = 30_000;
const platformCache = new Map<
  string,
  { at: number; value: Promise<unknown> }
>();

/**
 * Answers for one account are reused for 30 s, so refreshing the map, or re-reading it after a
 * file save, does not repeat a round trip per agent. `cacheKey` names the account (Studio and the
 * tool pass a hash of the credential); without it nothing is cached.
 */
function cached<T>(
  cacheKey: string | undefined,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  if (!cacheKey) return load();
  const full = `${cacheKey}\0${key}`;
  const hit = platformCache.get(full);
  if (hit && Date.now() - hit.at < PLATFORM_TTL_MS)
    return hit.value as Promise<T>;
  const value = load();
  platformCache.set(full, { at: Date.now(), value });
  value.catch(() => platformCache.delete(full));
  if (platformCache.size > 2000)
    platformCache.delete(platformCache.keys().next().value!);
  return value;
}

/** Triggers and deploy state from the signed-in account. */
export function accountPlatform(
  client: GatewayClient,
  options: { cacheKey?: string } = {},
): PlatformSource {
  return {
    deployedSlugs: () =>
      cached(options.cacheKey, "definitions", async () => {
        const definitions =
          await client.get<DefinitionSummary[]>("/definitions");
        return new Set(
          definitions.flatMap((definition) => [
            definition.slug ?? definition.name,
            definition.name,
          ]),
        );
      }),
    triggers: (slug) =>
      cached(options.cacheKey, `triggers\0${slug}`, async () => {
        const schedules = await listSchedules(
          { definition: slug, status: "active" },
          client,
        );
        return schedules.flatMap((schedule): DescribedTrigger[] => {
          if (schedule.kind === "event" && schedule.eventType) {
            return [
              {
                kind: "event",
                eventType: schedule.eventType,
                source: "platform",
              },
            ];
          }
          if (schedule.kind === "schedule_cron" && schedule.cron) {
            return [
              { kind: "schedule", cron: schedule.cron, source: "platform" },
            ];
          }
          return []; // one-off timers and webhooks join no agents
        });
      }),
  };
}

/** Jev through the signed-in account's API key, the same route the hosted capability uses. */
export function accountEvaluate(client: GatewayClient): Evaluate {
  return (request) => client.postAtHostRoot("/v1/capabilities/decisions.evaluate", request);
}
