import { execFile } from 'node:child_process';
import { platform } from 'node:os';

import { pollDeviceToken, startDeviceAuth } from '../../lib/auth.js';
import { CliError, isJsonMode, ok } from '../../lib/output.js';
import { writeCredential } from '../../lib/session.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function openBrowser(url: string): void {
  const os = platform();
  const [cmd, args] = os === 'darwin' ? ['open', [url]] : os === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    execFile(cmd as string, args as string[], () => {
      /* best-effort; the URL is always printed too */
    });
  } catch {
    /* ignore — the user can open the URL manually */
  }
}

/**
 * `sapiom login` — device-authorization flow. Opens the browser to approve,
 * polls for the credential, and stores it in the session.
 */
export async function runLogin(): Promise<void> {
  const start = await startDeviceAuth();

  if (!isJsonMode()) {
    process.stderr.write(
      `\nTo sign in, open:\n  ${start.verification_uri_complete}\n\n` +
        `Verification code: ${start.user_code}\n\nWaiting for approval…\n`,
    );
  }
  openBrowser(start.verification_uri_complete);

  let interval = (start.interval || 5) * 1000;
  const deadline = Date.now() + (start.expires_in || 600) * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    const res = await pollDeviceToken(start.device_code);

    if (res.access_token) {
      writeCredential({ apiKey: res.access_token });
      ok({ organization: res.organization_name, tenantId: res.tenant_id }, [
        `✓ Logged in${res.organization_name ? ` to ${res.organization_name}` : ''}.`,
      ]);
      return;
    }

    switch (res.error) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        interval += 5000;
        break;
      case 'access_denied':
        throw new CliError({ code: 'ACCESS_DENIED', message: 'Login was denied.' });
      case 'expired_token':
        throw new CliError({ code: 'LOGIN_EXPIRED', message: 'Login request expired.', hint: 'Run `sapiom login` again.' });
      default:
        // Unknown response — keep polling until the deadline.
        break;
    }
  }

  throw new CliError({ code: 'LOGIN_TIMEOUT', message: 'Login timed out.', hint: 'Run `sapiom login` again.' });
}
