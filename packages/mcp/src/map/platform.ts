import { listSchedules, type DefinitionSummary, type GatewayClient } from "@sapiom/agent-core";

import type { PlatformSource } from "./scan-project.js";
import type { DescribedTrigger } from "./types.js";

/** Triggers and deploy state from the signed-in account. */
export function accountPlatform(client: GatewayClient): PlatformSource {
  return {
    async deployedSlugs() {
      const definitions = await client.get<DefinitionSummary[]>("/definitions");
      return new Set(definitions.flatMap((definition) => [definition.slug ?? definition.name, definition.name]));
    },
    async triggers(slug) {
      const schedules = await listSchedules({ definition: slug, status: "active" }, client);
      return schedules.flatMap((schedule): DescribedTrigger[] => {
        if (schedule.kind === "event" && schedule.eventType) {
          return [{ kind: "event", eventType: schedule.eventType, source: "platform" }];
        }
        if (schedule.kind === "schedule_cron" && schedule.cron) {
          return [{ kind: "schedule", cron: schedule.cron, source: "platform" }];
        }
        return []; // one-off timers and webhooks join no agents
      });
    },
  };
}
