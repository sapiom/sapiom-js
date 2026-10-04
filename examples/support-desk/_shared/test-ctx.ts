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

/** One call the fake schedules client saw. */
export interface ScheduleCall {
  op: "create" | "cancel";
  id: string;
  at?: string;
  input?: unknown;
  definition?: string;
}

/**
 * A fake `@sapiom/tools` `schedules` client: records each create and cancel. `pending()` is the
 * set of schedules created and not cancelled.
 */
export function fakeSchedules() {
  const calls: ScheduleCall[] = [];
  let seq = 0;
  const client = {
    async create(spec: {
      definition: string;
      at?: string | Date;
      input?: unknown;
    }) {
      const id = `sched-${++seq}`;
      const at = spec.at instanceof Date ? spec.at.toISOString() : spec.at;
      calls.push({
        op: "create",
        id,
        at,
        input: spec.input,
        definition: spec.definition,
      });
      return { id, kind: "schedule_once", status: "active" } as never;
    },
    async cancel(id: string) {
      calls.push({ op: "cancel", id });
      return { id, status: "disabled" } as never;
    },
  };
  const pending = () =>
    calls.filter(
      (c) =>
        c.op === "create" &&
        !calls.some((x) => x.op === "cancel" && x.id === c.id),
    );
  return { client, calls, pending };
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
  const schedules = fakeSchedules();
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
    sapiom: { events, schedules: schedules.client } as never,
  };
  return { ctx, emitted, logs, schedules };
}
