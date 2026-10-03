/** Test-only: a fake step context. Never imported by an agent's index.ts. */
import type { EmitEventResult } from "@sapiom/tools";

import type { Sla } from "./sla";

/** Shared fixture from the README's SLA example. */
export const EXAMPLE_SLA: Sla = {
  businessHours: {
    timeZone: "America/New_York",
    days: [1, 2, 3, 4, 5],
    start: "09:00",
    end: "17:00",
  },
  targets: {
    urgent: {
      firstResponseMinutes: 15,
      nextResponseMinutes: 15,
      businessHours: false,
    },
    high: {
      firstResponseMinutes: 60,
      nextResponseMinutes: 60,
      businessHours: false,
    },
    normal: {
      firstResponseMinutes: 480,
      nextResponseMinutes: 480,
      businessHours: true,
    },
    low: {
      firstResponseMinutes: 480,
      nextResponseMinutes: 480,
      businessHours: true,
    },
  },
};

export interface Emitted {
  type: string;
  payload: Record<string, unknown>;
  id?: string;
}

export function fakeCtx(
  opts: {
    isLocalTrace?: boolean;
    executionId?: string;
    withEvents?: boolean;
  } = {},
) {
  const emitted: Emitted[] = [];
  const logs: { level: string; msg: string; data?: unknown }[] = [];
  const log = (level: string) => (msg: string, data?: unknown) =>
    void logs.push({ level, msg, data });
  const events =
    opts.withEvents === false
      ? undefined
      : {
          async emit(spec: Emitted): Promise<EmitEventResult> {
            const duplicate = emitted.some(
              (e) => e.id !== undefined && e.id === spec.id,
            );
            emitted.push(spec);
            return {
              receiptId: `rcpt-${emitted.length}`,
              outcome: "matched",
              duplicate,
              fireIds: duplicate ? [] : ["fire-1"],
            };
          },
        };
  const ctx = {
    executionId: opts.executionId ?? "exec-test",
    agentName: "test-agent",
    isLocalTrace: opts.isLocalTrace ?? false,
    logger: {
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
      debug: log("debug"),
    },
    sapiom: { events } as never,
  };
  return { ctx, emitted, logs };
}
