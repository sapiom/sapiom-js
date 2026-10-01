/** Test-only: a fake step context. Never imported by an agent's index.ts. */
import type { EmitEventResult } from "@sapiom/tools";

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
