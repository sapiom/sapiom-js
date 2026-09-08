import { watch } from "node:fs";
import { basename, dirname } from "node:path";

export interface CredentialDirectoryWatcher {
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type CredentialDirectoryWatch = (
  directory: string,
  listener: (event: string, filename: string | Buffer | null) => void,
) => CredentialDirectoryWatcher;

export interface CredentialStoreObserver {
  close(): void;
}

const defaultWatchDirectory: CredentialDirectoryWatch = (directory, listener) =>
  watch(directory, listener);

/**
 * Observe the shared credential file through its directory so an in-place
 * write or replacement produces the same refresh signal. This deliberately
 * has no polling/retry fallback. A missing directory returns no observer so
 * the caller can arm it after a known in-process credential write.
 */
export function observeCredentialStore(
  filePath: string,
  onChange: () => void | Promise<void>,
  options: {
    watchDirectory?: CredentialDirectoryWatch;
    debounceMs?: number;
    onError?: (error: unknown) => void;
    onUnavailable?: () => void;
  } = {},
): CredentialStoreObserver | null {
  const watchDirectory = options.watchDirectory ?? defaultWatchDirectory;
  const debounceMs = options.debounceMs ?? 50;
  const watchedName = basename(filePath);
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: CredentialDirectoryWatcher;

  try {
    watcher = watchDirectory(dirname(filePath), (_event, filename) => {
      if (closed) return;
      if (filename !== null && basename(String(filename)) !== watchedName)
        return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (closed) return;
        void Promise.resolve()
          .then(onChange)
          .catch((error: unknown) => options.onError?.(error));
      }, debounceMs);
      timer.unref?.();
    });
  } catch (error) {
    options.onError?.(error);
    options.onUnavailable?.();
    return null;
  }

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    try {
      watcher.close();
    } catch {
      // A watcher that emitted an error may already be closed by Node.
    }
  };
  watcher.on("error", (error) => {
    close();
    options.onError?.(error);
    options.onUnavailable?.();
  });
  return {
    close,
  };
}
