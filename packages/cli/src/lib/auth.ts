/**
 * Device-authorization (RFC 8628) client for `sapiom login`. These endpoints
 * live on the main Sapiom API (not the workflows gateway), so they have their
 * own host. The flow yields a durable API key, which the session store keeps.
 */
import { CliError } from './output.js';

const DEFAULT_API_HOST = 'https://api.sapiom.ai';
export const CLI_CLIENT_ID = 'sapiom-cli';

/** Host for the auth API. Override with SAPIOM_API_HOST. */
export function resolveApiHost(): string {
  return (process.env.SAPIOM_API_HOST ?? DEFAULT_API_HOST).replace(/\/$/, '');
}

export interface DeviceAuthStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTokenResult {
  access_token?: string;
  token_type?: string;
  tenant_id?: string;
  organization_name?: string;
  error?: string;
}

async function authPost(path: string, body: unknown): Promise<{ status: number; data: any }> {
  const host = resolveApiHost();
  let res: Response;
  try {
    res = await fetch(`${host}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new CliError({
      code: 'NETWORK',
      message: `Could not reach ${host}.`,
      hint: err instanceof Error ? err.message : String(err),
    });
  }
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

export async function startDeviceAuth(): Promise<DeviceAuthStart> {
  const { status, data } = await authPost('/auth/device', { client_id: CLI_CLIENT_ID });
  if (status !== 200 || !data?.device_code) {
    throw new CliError({
      code: 'LOGIN_START_FAILED',
      message: 'Could not start login.',
      hint: typeof data?.message === 'string' ? data.message : `HTTP ${status}`,
    });
  }
  return data as DeviceAuthStart;
}

/** One poll. Returns the token result or an RFC 8628 error in `error`. */
export async function pollDeviceToken(deviceCode: string): Promise<DeviceTokenResult> {
  const { data } = await authPost('/auth/device/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
    client_id: CLI_CLIENT_ID,
  });
  return (data ?? {}) as DeviceTokenResult;
}
