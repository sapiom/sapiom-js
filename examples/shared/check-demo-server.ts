const DEMO_HEALTH_PATH = "/api/public/time";

export interface DemoServerCheckResult {
  ok: boolean;
  status?: number;
  cloudflareBlocked?: boolean;
  error?: string;
}

/**
 * Probe the demo server with plain fetch (no Sapiom SDK) before running examples.
 */
export async function checkDemoServer(
  baseUrl: string,
): Promise<DemoServerCheckResult> {
  const url = `${baseUrl.replace(/\/$/, "")}${DEMO_HEALTH_PATH}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (response.ok) {
      return { ok: true, status: response.status };
    }

    const server = response.headers.get("server") ?? "";
    let body = "";
    try {
      body = await response.text();
    } catch {
      // ignore body read errors
    }

    const cloudflareBlocked =
      response.status === 403 &&
      (server.toLowerCase().includes("cloudflare") ||
        body.includes("Cloudflare") ||
        body.includes("you have been blocked"));

    return {
      ok: false,
      status: response.status,
      cloudflareBlocked,
      error: cloudflareBlocked
        ? "Demo server blocked by Cloudflare (403)"
        : `Demo server returned HTTP ${response.status}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const unreachable =
      message.includes("fetch failed") ||
      message.includes("ECONNREFUSED") ||
      message.includes("ENOTFOUND");

    return {
      ok: false,
      error: unreachable
        ? `Cannot reach demo server at ${baseUrl} (${message})`
        : `Demo server health check failed: ${message}`,
    };
  }
}

export function printDemoServerUnreachable(
  baseUrl: string,
  result: DemoServerCheckResult,
): void {
  const healthUrl = `${baseUrl.replace(/\/$/, "")}${DEMO_HEALTH_PATH}`;

  console.error("");
  console.error("Demo server unreachable — skipping example.");
  console.error(`  URL: ${healthUrl}`);
  if (result.status !== undefined) {
    console.error(`  HTTP: ${result.status}`);
  }
  if (result.error) {
    console.error(`  Reason: ${result.error}`);
  }
  console.error("");

  if (result.cloudflareBlocked) {
    console.error(
      "The hosted demo is blocked by Cloudflare, not the Sapiom SDK.",
    );
    console.error(
      "Check open issues at https://github.com/sapiom/sapiom-js/issues",
    );
  } else {
    console.error("Verify DUMMY_SERVER_URL in .env, or run:");
    console.error(`  curl -v ${healthUrl}`);
  }

  console.error("");
  console.error(
    "Note: http://localhost:3101 is not bundled in this repo — examples expect the hosted demo.",
  );
  console.error("");
}

export async function assertDemoServerReachable(baseUrl: string): Promise<void> {
  const result = await checkDemoServer(baseUrl);
  if (!result.ok) {
    printDemoServerUnreachable(baseUrl, result);
    process.exit(1);
  }
}
