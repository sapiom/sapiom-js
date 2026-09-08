import { afterEach, describe, expect, it, vi } from "vitest";

import {
  observeCredentialStore,
  type CredentialDirectoryWatch,
} from "./credential-store-observer.js";

describe("observeCredentialStore", () => {
  afterEach(() => vi.useRealTimers());

  it("debounces only matching credential-file events and stops cleanly", async () => {
    vi.useFakeTimers();
    let notify!: (event: string, filename: string | Buffer | null) => void;
    const close = vi.fn();
    const watchDirectory: CredentialDirectoryWatch = vi.fn(
      (_directory, listener) => {
        notify = listener;
        return { close, on: () => undefined };
      },
    );
    const onChange = vi.fn(async () => {});
    const observer = observeCredentialStore(
      "/users/test/.sapiom/credentials.json",
      onChange,
      { watchDirectory, debounceMs: 25 },
    );

    expect(watchDirectory).toHaveBeenCalledWith(
      "/users/test/.sapiom",
      expect.any(Function),
    );
    notify("change", "settings.json");
    notify("change", "credentials.json");
    notify("rename", "credentials.json");
    await vi.advanceTimersByTimeAsync(25);
    expect(onChange).toHaveBeenCalledOnce();

    observer.close();
    notify("change", "credentials.json");
    await vi.advanceTimersByTimeAsync(25);
    expect(onChange).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("degrades to a closed observer when the credentials directory is absent", () => {
    const error = new Error("ENOENT");
    const onError = vi.fn();
    const observer = observeCredentialStore("/missing/credentials.json", vi.fn(), {
      watchDirectory: () => {
        throw error;
      },
      onError,
    });

    expect(onError).toHaveBeenCalledWith(error);
    expect(() => observer.close()).not.toThrow();
  });
});
