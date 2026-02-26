import * as http from "node:http";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import { URL, URLSearchParams } from "node:url";

/** Result of a successful authentication flow (browser or device). */
export interface AuthResult {
  /** Sapiom API key for authenticating subsequent requests. */
  apiKey: string;
  /** Tenant ID the authenticated user belongs to. */
  tenantId: string;
  /** Human-readable organization name for display purposes. */
  organizationName: string;
  /** Unique identifier of the API key (not the key itself). */
  apiKeyId: string;
}

/** Response from POST /auth/device (RFC 8628 §3.2). */
export interface DeviceAuthInitiation {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      execSync(`open "${url}"`);
    } else if (platform === "win32") {
      execSync(`start "" "${url}"`);
    } else {
      execSync(`xdg-open "${url}"`);
    }
  } catch {
    // Browser open failed — user will see the URL in the output
  }
}

export async function performBrowserAuth(
  appURL: string,
  apiURL: string,
): Promise<AuthResult> {
  const state = crypto.randomBytes(32).toString("hex");

  return new Promise<AuthResult>((resolve, reject) => {
    const server = http.createServer();
    let settled = false;

    const timeout = setTimeout(
      () => {
        if (!settled) {
          settled = true;
          server.close();
          reject(
            new Error(
              `Authentication timed out after 5 minutes. Open this URL manually to try again:\n${browserURL}`,
            ),
          );
        }
      },
      5 * 60 * 1000,
    );

    // Placeholder — set after we know the port
    let browserURL = "";

    server.on("request", async (req, res) => {
      if (settled) return;

      const reqURL = new URL(req.url ?? "/", `http://localhost`);

      if (reqURL.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const code = reqURL.searchParams.get("code");
      const returnedState = reqURL.searchParams.get("state");

      // Serve the "you can close this tab" page immediately
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Sapiom CLI Auth</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
  <div style="text-align: center;">
    <h1>Authentication complete</h1>
    <p>You can close this tab and return to your terminal.</p>
  </div>
</body>
</html>`);

      if (!returnedState || returnedState !== state) {
        settled = true;
        clearTimeout(timeout);
        server.close();
        reject(
          new Error("State mismatch — possible CSRF attack. Please try again."),
        );
        return;
      }

      if (!code) {
        settled = true;
        clearTimeout(timeout);
        server.close();
        reject(new Error("No authorization code received from the browser."));
        return;
      }

      // Exchange the code for an API key
      try {
        const address = server.address() as { port: number };
        const redirectUri = `http://localhost:${address.port}/callback`;
        const result = await exchangeCodeForApiKey(apiURL, code, redirectUri);
        settled = true;
        clearTimeout(timeout);
        server.close();
        resolve(result);
      } catch (err) {
        settled = true;
        clearTimeout(timeout);
        server.close();
        reject(err);
      }
    });

    // Listen on random port
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      const port = address.port;
      const redirectUri = `http://localhost:${port}/callback`;
      const params = new URLSearchParams({
        redirect_uri: redirectUri,
        state,
      });
      browserURL = `${appURL}/auth/cli?${params.toString()}`;

      console.error(`Opening browser for authentication...`);
      console.error(`If the browser doesn't open, visit: ${browserURL}`);

      openBrowser(browserURL);
    });

    server.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Failed to start local server: ${err.message}`));
      }
    });
  });
}

/**
 * Run an RFC 8628 device authorization flow.
 *
 * Initiates the flow and returns the device/user codes immediately so the
 * caller can display them. The returned `result` promise resolves when the
 * user approves the code on another device.
 *
 * @param apiURL - Sapiom API URL (e.g. `https://api.sapiom.ai`).
 * @param clientId - Client identifier sent with the device auth request.
 */
export async function performDeviceAuth(
  apiURL: string,
  clientId = "sapiom-mcp",
): Promise<{ initiation: DeviceAuthInitiation; result: Promise<AuthResult> }> {
  // Step 1: Initiate device auth
  const initResponse = await fetch(`${apiURL}/v1/auth/device`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });

  if (!initResponse.ok) {
    let message = `Device auth initiation failed (${initResponse.status})`;
    try {
      const body = (await initResponse.json()) as { message?: string };
      if (body.message) message = `Device auth initiation failed: ${body.message}`;
    } catch {
      // Ignore JSON parse errors
    }
    throw new Error(message);
  }

  const initiation = (await initResponse.json()) as DeviceAuthInitiation;

  // Step 2: Poll for token in the background
  const result = pollForDeviceToken(
    apiURL,
    initiation.device_code,
    clientId,
    initiation.interval,
    initiation.expires_in,
  );

  return { initiation, result };
}

/**
 * Poll the device token endpoint until the user approves, denies, or the code expires.
 * @internal
 */
async function pollForDeviceToken(
  apiURL: string,
  deviceCode: string,
  clientId: string,
  initialInterval: number,
  expiresIn: number,
): Promise<AuthResult> {
  let interval = initialInterval;
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await sleep(interval * 1000);

    const response = await fetch(`${apiURL}/v1/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: clientId,
      }),
    });

    const body = (await response.json()) as {
      error?: string;
      access_token?: string;
      token_type?: string;
      tenant_id?: string;
      organization_name?: string;
      api_key_id?: string;
    };

    if (response.ok && body.access_token) {
      return {
        apiKey: body.access_token,
        tenantId: body.tenant_id!,
        organizationName: body.organization_name!,
        apiKeyId: body.api_key_id ?? "",
      };
    }

    if (body.error === "authorization_pending") {
      continue;
    }

    if (body.error === "slow_down") {
      interval += 5;
      continue;
    }

    if (body.error === "access_denied") {
      throw new Error("Device authorization was denied by the user.");
    }

    if (body.error === "expired_token") {
      throw new Error("Device code expired. Please start a new authorization flow.");
    }

    // Unknown error
    throw new Error(`Device auth failed: ${body.error ?? `HTTP ${response.status}`}`);
  }

  throw new Error("Device code expired. Please start a new authorization flow.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exchangeCodeForApiKey(
  apiURL: string,
  code: string,
  redirectUri: string,
): Promise<AuthResult> {
  const response = await fetch(`${apiURL}/v1/auth/cli/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, redirectUri }),
  });

  if (!response.ok) {
    let message = `Token exchange failed (${response.status})`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) {
        message = `Token exchange failed: ${body.message}`;
      }
    } catch {
      // Ignore JSON parse errors
    }
    throw new Error(message);
  }

  const data = (await response.json()) as AuthResult;

  if (!data.apiKey || !data.tenantId) {
    throw new Error("Invalid response from token exchange endpoint");
  }

  return data;
}
