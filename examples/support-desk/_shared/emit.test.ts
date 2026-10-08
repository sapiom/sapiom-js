import { describe, expect, it } from "vitest";

import { fixture } from "../fixtures/index";
import { memoryDb } from "./db";
import { emit, emitId } from "./emit";
import type { EventPayload } from "./events";
import { fakeCtx } from "./test-ctx";

const created = fixture("issue/created.json")
  .payload as EventPayload<"issue.created">;

describe("emit", () => {
  it("validates, emits with a type-scoped dedup id, and logs the receipt", async () => {
    const db = await memoryDb();
    const { ctx, emitted } = fakeCtx();
    const result = await emit(ctx as never, db, "issue.created", created);
    expect(emitted).toEqual([
      {
        type: "issue.created",
        payload: created,
        id: `issue.created:${created.causationId}`,
      },
    ]);
    expect(result.outcome).toBe("matched");
    const rows = await db.query<{
      type: string;
      receipt_id: string;
      emitted_by: string;
    }>("select type, receipt_id, emitted_by from events_log");
    expect(rows).toEqual([
      { type: "issue.created", receipt_id: "rcpt-1", emitted_by: "test-agent" },
    ]);
  });

  it("gives two event types from one causation different ids", () => {
    expect(emitId("issue.created", "Ev1")).not.toBe(
      emitId("issue.message_added", "Ev1"),
    );
  });

  it("refuses an invalid payload before emitting", async () => {
    const db = await memoryDb();
    const { ctx, emitted } = fakeCtx();
    await expect(
      emit(ctx as never, db, "issue.created", { ...created, issueId: "nope" }),
    ).rejects.toThrow();
    expect(emitted).toEqual([]);
  });

  it("names the missing SDK when ctx.sapiom.events is absent", async () => {
    const db = await memoryDb();
    const { ctx } = fakeCtx({ withEvents: false });
    await expect(
      emit(ctx as never, db, "issue.created", created),
    ).rejects.toThrow(/@sapiom\/tools >= 0.40.0/);
  });
});
