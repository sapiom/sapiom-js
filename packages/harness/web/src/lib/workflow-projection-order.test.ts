import { describe, expect, it } from "vitest";

import { WorkflowProjectionOrder } from "./workflow-projection-order";

describe("WorkflowProjectionOrder", () => {
  it("rejects an older boot response after a newer event refresh commits", () => {
    const order = new WorkflowProjectionOrder<string>();
    const boot = order.begin();
    const event = order.begin();

    expect(order.accept(event, ["new"])).toBe(true);
    expect(order.accept(boot, ["old"])).toBe(false);
    expect(order.current()).toEqual(["new"]);
  });

  it("keeps an older success as fallback while the newest request is pending", () => {
    const order = new WorkflowProjectionOrder<string>();
    const baseline = order.begin();
    expect(order.accept(baseline, ["baseline"])).toBe(true);

    const older = order.begin();
    const newest = order.begin();
    expect(order.accept(older, ["fallback"])).toBe(true);
    expect(order.current()).toEqual(["fallback"]);

    expect(order.accept(newest, ["latest"])).toBe(true);
    expect(order.current()).toEqual(["latest"]);
  });

  it("lets a later boot retry supersede an earlier successful retry", () => {
    const order = new WorkflowProjectionOrder<string>();
    const first = order.begin();
    const retry = order.begin();

    expect(order.accept(first, ["first"])).toBe(true);
    expect(order.current()).toEqual(["first"]);
    expect(order.accept(retry, ["retry"])).toBe(true);
    expect(order.current()).toEqual(["retry"]);
  });

  it("retains a boot success when a newer request fails without committing", () => {
    const order = new WorkflowProjectionOrder<string>();
    const boot = order.begin();
    order.begin(); // newer event request; its rejected promise never calls accept

    expect(order.accept(boot, ["boot"])).toBe(true);
    expect(order.current()).toEqual(["boot"]);
  });

  it("does not let a connect re-list resurrect a newer event deletion", () => {
    const order = new WorkflowProjectionOrder<string>();
    const connectList = order.begin();
    const deletionEventList = order.begin();

    expect(order.accept(deletionEventList, [])).toBe(true);
    expect(order.accept(connectList, ["connected"])).toBe(false);
    expect(order.current()).toEqual([]);
  });

  it("does not let an older event list erase a newer connect re-list", () => {
    const order = new WorkflowProjectionOrder<string>();
    const eventList = order.begin();
    const connectList = order.begin();

    expect(order.accept(connectList, ["connected"])).toBe(true);
    expect(order.accept(eventList, [])).toBe(false);
    expect(order.current()).toEqual(["connected"]);
  });
});
