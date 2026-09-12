import { afterEach, expect, it, vi } from "vitest";
vi.mock("./api", () => ({
  isMockMode: () => false,
  getBootToken: () => "boot",
}));
import { subscribeEvents } from "./events";
import { AssistantStateOrder } from "./assistant-state";

class Socket {
  static instances: Socket[] = [];
  callbacks = new Map<string, ((event: { data?: string }) => void)[]>();
  constructor(readonly url: URL) {
    Socket.instances.push(this);
  }
  addEventListener(type: string, callback: (event: { data?: string }) => void) {
    this.callbacks.set(type, [...(this.callbacks.get(type) ?? []), callback]);
  }
  emit(type: string, data?: unknown) {
    for (const callback of this.callbacks.get(type) ?? [])
      callback({ data: JSON.stringify(data) });
  }
  close() {
    this.emit("close");
  }
}
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Socket.instances = [];
});

it("fences old socket callbacks during retry and makes only validated snapshots current", () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { location: { href: "http://localhost:1234" } });
  vi.stubGlobal("WebSocket", Socket);
  const order = new AssistantStateOrder();
  const messages = vi.fn((message, generation) =>
    order.socket(generation, message.snapshot),
  );
  const reconnect = vi.fn();
  const stop = subscribeEvents(messages, reconnect, (connection) =>
    order.transport(connection),
  );
  const first = Socket.instances[0]!;
  expect(first.url.searchParams.get("token")).toBe("boot");
  first.emit("open");
  expect(order.current().current).toBe(false);
  const frame = {
    type: "assistant.state",
    snapshot: {
      hostInstanceId: "host",
      authorityRevision: "auth",
      revision: 1,
      enabled: true,
      sessions: [],
    },
  };
  first.emit("message", frame);
  expect(order.current().current).toBe(true);
  first.emit("close");
  first.emit("open");
  first.emit("message", frame);
  first.emit("close");
  expect(messages).toHaveBeenCalledTimes(1);
  expect(reconnect).not.toHaveBeenCalled();
  expect(order.current().current).toBe(false);
  vi.advanceTimersByTime(2000);
  expect(Socket.instances).toHaveLength(2);
  const second = Socket.instances[1]!;
  second.emit("open");
  expect(reconnect).toHaveBeenCalledOnce();
  expect(order.current().current).toBe(false);
  first.emit("message", frame);
  second.emit("message", frame);
  expect(order.current().current).toBe(true);
  const firstGeneration = messages.mock.calls[0]![1];
  expect(messages.mock.calls[1]![1]).toBeGreaterThan(firstGeneration);
  stop();
  second.emit("open");
  second.emit("message", frame);
  second.emit("close");
  vi.advanceTimersByTime(4000);
  expect(messages).toHaveBeenCalledTimes(2);
  expect(Socket.instances).toHaveLength(2);
  expect(order.current().current).toBe(false);
  const fresh = vi.fn();
  const stopFresh = subscribeEvents(fresh);
  Socket.instances[2]!.emit("open");
  Socket.instances[2]!.emit("message", frame);
  expect(fresh.mock.calls[0]![1]).toBeGreaterThan(messages.mock.calls[1]![1]);
  Socket.instances[2]!.emit("close");
  stopFresh();
  vi.advanceTimersByTime(4000);
  expect(Socket.instances).toHaveLength(3);
});
