import { describe, it, expect, vi } from "vitest";
import { EventBus } from "./event-bus.js";

describe("EventBus", () => {
  it("delivers a published message to a subscriber", () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.subscribe(listener);
    bus.publish({ type: "workflows.changed" });
    expect(listener).toHaveBeenCalledWith({ type: "workflows.changed" });
  });

  it("delivers to multiple subscribers", () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);
    bus.publish({ type: "canvas.reload", harnessSessionId: "sess-1" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops further delivery to that listener only", () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribeA = bus.subscribe(a);
    bus.subscribe(b);

    unsubscribeA();
    bus.publish({ type: "workflows.changed" });

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("supports many subscribers without a MaxListenersExceededWarning", () => {
    const bus = new EventBus();
    const warn = vi.fn();
    process.on("warning", warn);
    for (let i = 0; i < 50; i++) bus.subscribe(() => {});
    bus.publish({ type: "workflows.changed" });
    process.off("warning", warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
