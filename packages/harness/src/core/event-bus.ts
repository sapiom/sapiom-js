/**
 * In-process pub/sub for BusMessage — the single source every /ws/events
 * connection forwards from, and every producer (session status, canvas
 * watcher, port detector, workflow registry changes) publishes to. Keeping
 * this as one shared instance (rather than each producer reaching into the
 * WS layer directly) is what lets canvas.reload / port.detected be added
 * without touching events-ws.ts's connection-handling logic.
 */
import { EventEmitter } from "node:events";
import type { BusMessage } from "../shared/types.js";

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Every open /ws/events connection subscribes for its lifetime.
    this.emitter.setMaxListeners(0);
  }

  publish(message: BusMessage): void {
    this.emitter.emit("message", message);
  }

  /** Returns an unsubscribe function. */
  subscribe(listener: (message: BusMessage) => void): () => void {
    this.emitter.on("message", listener);
    return () => this.emitter.off("message", listener);
  }
}
