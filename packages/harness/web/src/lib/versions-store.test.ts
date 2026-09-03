import { describe, it, expect, vi } from "vitest";
import type { AgentVersionsView } from "@shared/types";

import { EMPTY_SNAPSHOT, VersionsStore } from "./versions-store";

function view(over: Partial<AgentVersionsView> = {}): AgentVersionsView {
  return {
    versions: [],
    activeSha: null,
    pinned: false,
    total: 0,
    local: null,
    ...over,
  };
}

/** A fetcher whose responses are controlled per call. */
function fetcherOf(...responses: AgentVersionsView[]) {
  let i = 0;
  return vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);
}

describe("VersionsStore — one copy for every surface", () => {
  /**
   * The bug this store exists for. The Versions tab and the header chip are
   * mounted together; with a per-component copy, resuming "follow latest" in
   * the tab cleared its banner while the chip went on reading `· pinned`.
   */
  it("notifies every subscriber after a write, so no surface stays stale", async () => {
    const store = new VersionsStore(
      fetcherOf(
        view({ activeSha: "old", pinned: true }),
        view({ activeSha: "new", pinned: false }),
      ),
    );
    // Nullable: listeners also fire for the `loading` flip, before any view.
    const seenByTab: (boolean | undefined)[] = [];
    const seenByChip: (boolean | undefined)[] = [];
    store.subscribe("46", () => seenByTab.push(store.snapshot("46").view?.pinned));
    store.subscribe("46", () => seenByChip.push(store.snapshot("46").view?.pinned));

    await store.load("46", null);
    expect(store.snapshot("46").view?.pinned).toBe(true);

    await store.mutate("46", null, null, async () => {});

    expect(store.snapshot("46").view?.pinned).toBe(false);
    // Both surfaces saw the flip, not just the one that issued the write.
    expect(seenByTab.at(-1)).toBe(false);
    expect(seenByChip.at(-1)).toBe(false);
  });

  it("stops notifying once unsubscribed", async () => {
    const store = new VersionsStore(fetcherOf(view()));
    const listener = vi.fn();
    const off = store.subscribe("46", listener);
    off();
    await store.load("46", null);
    expect(listener).not.toHaveBeenCalled();
  });

  it("survives a listener that unsubscribes while being notified", async () => {
    const store = new VersionsStore(fetcherOf(view()));
    const off = store.subscribe("46", () => off());
    await expect(store.load("46", null)).resolves.toBeUndefined();
  });
});

describe("VersionsStore — snapshots", () => {
  it("reports the shared frozen snapshot for a key never loaded", () => {
    const store = new VersionsStore(fetcherOf(view()));
    expect(store.snapshot("nope")).toBe(EMPTY_SNAPSHOT);
  });

  /**
   * `useSyncExternalStore` re-renders whenever the snapshot identity changes,
   * so a fresh object per call would loop forever.
   */
  it("returns the same object while nothing changes", async () => {
    const store = new VersionsStore(fetcherOf(view()));
    await store.load("46", null);
    expect(store.snapshot("46")).toBe(store.snapshot("46"));
  });

  it("keeps agents apart", async () => {
    const store = new VersionsStore(
      vi.fn(async (id: string) => view({ activeSha: `sha-${id}` })),
    );
    await Promise.all([store.load("46", null), store.load("49", null)]);
    expect(store.snapshot("46").view?.activeSha).toBe("sha-46");
    expect(store.snapshot("49").view?.activeSha).toBe("sha-49");
  });
});

describe("VersionsStore — request sharing", () => {
  /**
   * Three surfaces mount together. Each duplicate GET re-packs and re-hashes
   * the project directory server-side to report the local copy, so collapsing
   * them is worth the bookkeeping.
   */
  it("collapses concurrent loads onto one request", async () => {
    const fetcher = fetcherOf(view());
    const store = new VersionsStore(fetcher);
    await Promise.all([
      store.load("46", null),
      store.load("46", null),
      store.load("46", null),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("still refetches when forced, which is the point after a write", async () => {
    const fetcher = fetcherOf(view());
    const store = new VersionsStore(fetcher);
    await store.load("46", null);
    await store.load("46", null, { force: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not leave a stale in-flight entry behind after a forced overlap", async () => {
    const fetcher = fetcherOf(view());
    const store = new VersionsStore(fetcher);
    // Overlap deliberately: the first request must not clear the second's slot.
    await Promise.all([
      store.load("46", null),
      store.load("46", null, { force: true }),
    ]);
    // A later load is a fresh request rather than a resolved leftover promise.
    await store.load("46", null);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("clears loading only once every overlapping request has finished", async () => {
    const store = new VersionsStore(fetcherOf(view()));
    const both = Promise.all([
      store.load("46", null),
      store.load("46", null, { force: true }),
    ]);
    expect(store.snapshot("46").loading).toBe(true);
    await both;
    expect(store.snapshot("46").loading).toBe(false);
  });
});

describe("VersionsStore — failures", () => {
  it("drops the view and reports the message when a load fails", async () => {
    const store = new VersionsStore(async () => {
      throw new Error("not signed in to Sapiom");
    });
    await store.load("46", null);
    expect(store.snapshot("46")).toMatchObject({
      view: null,
      error: "not signed in to Sapiom",
      loading: false,
    });
  });

  /**
   * The refetch that follows a failed write succeeds and clears `error` on its
   * way past, which would leave the user staring at an unchanged list with no
   * explanation. The message is restated afterwards.
   */
  it("keeps a failed write's message after the refetch that follows it", async () => {
    const store = new VersionsStore(fetcherOf(view({ activeSha: "unchanged" })));
    await store.load("46", null);
    await store.mutate("46", null, "abc", async () => {
      throw new Error("label `latest` is reserved");
    });
    expect(store.snapshot("46").error).toBe("label `latest` is reserved");
    // ...and the list still shows what the server actually holds.
    expect(store.snapshot("46").view?.activeSha).toBe("unchanged");
  });

  it("uses the injected describer, so Core's own wording reaches the panel", async () => {
    const store = new VersionsStore(
      async () => {
        throw { status: 409, body: "conflict" };
      },
      (err) => `core says ${(err as { status: number }).status}`,
    );
    await store.load("46", null);
    expect(store.snapshot("46").error).toBe("core says 409");
  });
});

describe("VersionsStore — pendingSha", () => {
  it("marks the row being written, then clears it", async () => {
    const store = new VersionsStore(fetcherOf(view()));
    const seen: (string | null)[] = [];
    store.subscribe("46", () => seen.push(store.snapshot("46").pendingSha));
    await store.mutate("46", null, "abc123", async () => {});
    expect(seen).toContain("abc123");
    expect(store.snapshot("46").pendingSha).toBeNull();
  });

  it("clears the row marker even when the write throws", async () => {
    const store = new VersionsStore(fetcherOf(view()));
    await store.mutate("46", null, "abc123", async () => {
      throw new Error("nope");
    });
    expect(store.snapshot("46").pendingSha).toBeNull();
  });

  it("passes the project dir through to the refetch", async () => {
    const fetcher = vi.fn(async () => view());
    const store = new VersionsStore(fetcher);
    await store.mutate("46", "/home/a/agent289-demo2/fresh", null, async () => {});
    expect(fetcher).toHaveBeenCalledWith("46", "/home/a/agent289-demo2/fresh");
  });
});
