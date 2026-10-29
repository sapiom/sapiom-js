import { isRecord } from "./guards.js";

const MAX_DISCOVERY_BYTES = 64 * 1024;

function parseEndpoint(value: string): URL {
  try {
    const url = new URL(value);
    if (url.username || url.password) throw new Error();
    return url;
  } catch {
    throw new Error("CDP endpoint URL is invalid");
  }
}

/** Resolve a provider's discovery URL without exposing its session credentials. */
export async function resolveCdpEndpoint(
  value: string,
  timeoutMs: number,
): Promise<string> {
  const url = parseEndpoint(value);
  if (url.protocol === "ws:" || url.protocol === "wss:") return url.href;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CDP endpoint must use ws, wss, http or https");
  }
  // Keep provider path prefixes and query credentials; never forward them to
  // a redirect or append them to the WebSocket URL returned by the provider.
  if (!/\/json\/version\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/json/version`;
  }
  url.hash = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        length += chunk.byteLength;
        if (length > MAX_DISCOVERY_BYTES) throw new Error();
        chunks.push(chunk);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(data) || typeof data.webSocketDebuggerUrl !== "string") {
      throw new Error();
    }
    const endpoint = parseEndpoint(data.webSocketDebuggerUrl);
    if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
      throw new Error();
    }
    if (url.protocol === "https:" && endpoint.protocol !== "wss:") {
      throw new Error();
    }
    return endpoint.href;
  } catch {
    // Fetch errors and response bodies can contain tokens in paths or queries.
    throw new Error(
      controller.signal.aborted
        ? "CDP endpoint discovery timed out"
        : "CDP endpoint discovery failed",
    );
  } finally {
    clearTimeout(timer);
  }
}
