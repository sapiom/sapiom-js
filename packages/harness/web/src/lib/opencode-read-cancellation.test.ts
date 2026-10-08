import { expect, it, vi } from "vitest";
import {
  createOpencodeClient,
  OpenCodeThreadController,
  type OpenCodeServerEvent,
} from "@assistant-ui/react-opencode";

function fixture(failHistory = false) {
  const active = new Set<AbortSignal>();
  const cleanups: Array<() => void> = [];
  let peak = 0;
  let receive!: (event: OpenCodeServerEvent) => void;
  const client = createOpencodeClient({
    baseUrl: "http://native.invalid",
    fetch: (input, init) => {
      const request = new Request(input, init);
      if (failHistory && new URL(request.url).pathname.endsWith("/message"))
        return Promise.reject(new Error("history unavailable"));
      return new Promise<Response>((_, reject) => {
        const signal = request.signal;
        const cancel = () => {
          active.delete(signal);
          reject(new Error("aborted"));
        };
        cleanups.push(cancel);
        if (signal.aborted) {
          cancel();
          return;
        }
        active.add(signal);
        peak = Math.max(peak, active.size);
        signal.addEventListener("abort", cancel, { once: true });
      });
    },
  });
  const controller = new OpenCodeThreadController(
    client,
    () => ({
      subscribe: (listener) => {
        receive = listener;
        return () => {};
      },
    }),
    "session-a",
  );
  const unsubscribe = controller.subscribe(() => {});
  const emit = (type: string) =>
    receive({ type, sessionId: undefined, properties: {}, raw: undefined });
  return {
    controller,
    unsubscribe,
    active,
    emit,
    peak: () => peak,
    cleanup() {
      controller.dispose();
      for (const cancel of cleanups) cancel();
    },
  };
}

it.each(["disconnect", "dispose", "unsubscribe"])(
  "aborts actual SDK catch-up fetches on %s before reattaching",
  async (action) => {
    const f = fixture();
    try {
      f.emit("stream.reconnected");
      await vi.waitFor(() => expect(f.active.size).toBe(5));
      const previous = [...f.active];
      if (action === "disconnect") f.emit("stream.disconnected");
      else if (action === "dispose") f.controller.dispose();
      else f.unsubscribe();
      await vi.waitFor(() => expect(f.active.size).toBe(0));
      expect(previous.every((signal) => signal.aborted)).toBe(true);
      f.controller.subscribe(() => {});
      f.emit("stream.reconnected");
      await vi.waitFor(() => expect(f.active.size).toBe(5));
      expect(f.peak()).toBe(5);
    } finally {
      f.cleanup();
    }
  },
);

it("cancels the other half of a failed history read", async () => {
  const f = fixture(true);
  try {
    await expect(f.controller.load()).rejects.toThrow();
    await vi.waitFor(() => expect(f.active.size).toBe(0));
  } finally {
    f.cleanup();
  }
});
