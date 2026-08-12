import * as http from "node:http";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { URL, URLSearchParams } from "node:url";

export interface AuthResult {
  apiKey: string;
  tenantId: string;
  organizationName: string;
  apiKeyId: string;
}

/**
 * Fire-and-forget browser launch. Three properties matter here, all learned
 * from this running inside an MCP server on Windows:
 *
 *  - NEVER a visible console. The previous `execSync('start "" "<url>"')`
 *    spawned cmd.exe, which pops a console window on the user's screen when
 *    the caller isn't attached to one (an MCP server child of a GUI app
 *    never is). PowerShell here runs with CREATE_NO_WINDOW (`windowsHide`).
 *  - NEVER synchronous. execSync blocked the tool handler on the opener
 *    process itself; a wedged opener wedged the tool call.
 *  - NEVER a shell-parsed URL. The OAuth URL carries `&` in its query, which
 *    a cmd.exe command line treats as a command separator unless quoted
 *    exactly right. The PowerShell command is passed BASE64-ENCODED
 *    (-EncodedCommand), so no shell ever tokenizes the URL; the
 *    single-quoted PS literal only needs `'` doubled, and percent-encoded
 *    OAuth URLs cannot contain `'`.
 *
 * Failure is still non-fatal by design: the caller's stderr line and the
 * timeout error both carry the URL for a manual open.
 */
function openBrowser(url: string): void {
  try {
    const child =
      process.platform === "win32"
        ? spawn(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-WindowStyle",
              "Hidden",
              "-EncodedCommand",
              Buffer.from(`Start-Process '${url.replace(/'/g, "''")}'`, "utf16le").toString(
                "base64",
              ),
            ],
            { stdio: "ignore", windowsHide: true, detached: true },
          )
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
            stdio: "ignore",
            detached: true,
          });
    // A missing opener binary rejects asynchronously — swallow it the same
    // way the old catch did, or the ENOENT crashes the whole server.
    child.on("error", () => {});
    child.unref();
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
