import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import {
  credentialsFilePath,
  type CredentialsFile,
  type ResolvedEnvironment,
  type StudioCredentials,
} from "@sapiom/mcp/auth";
import { DurableFileLock } from "./durable-file-lock.js";

/** Shared by Studio login, sign-out and refresh across CLI/desktop hosts. */
export async function withStudioCredentialLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const unlock = await new DurableFileLock(`${credentialsFilePath()}.studio`, {
    timeoutMs: 8000,
  }).acquire();
  try {
    return await operation();
  } finally {
    await unlock();
  }
}

/** Rotate under the store lock, then persist atomically before exposing a token. */
export async function refreshStudioCredentials(
  env: ResolvedEnvironment,
): Promise<StudioCredentials | null> {
  return withStudioCredentialLock(async () => {
    const filePath = credentialsFilePath();
    const file = JSON.parse(
      await readFile(filePath, "utf8"),
    ) as CredentialsFile;
    const entry = file.environments[env.name];
    if (
      entry?.apiURL !== env.apiURL ||
      entry.credentials?.apiKey !== env.credentials?.apiKey
    )
      return null;
    const credentials = entry.credentials?.studioCredentials;
    if (!credentials) return null;
    if (Date.parse(credentials.expiresAt) > Date.now() + 90_000)
      return credentials;
    const response = await fetch(`${env.apiURL}/v1/tokens/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: credentials.refreshToken }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error("Sign in again to restore Assistant access");
    const pair = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (
      !pair.access_token?.startsWith("sat_") ||
      !pair.refresh_token?.startsWith("srt_") ||
      typeof pair.expires_in !== "number" ||
      !Number.isFinite(pair.expires_in) ||
      pair.expires_in <= 0
    )
      throw new Error("Invalid Studio credential refresh");
    const next = {
      accessToken: pair.access_token,
      refreshToken: pair.refresh_token,
      expiresAt: new Date(Date.now() + pair.expires_in * 1000).toISOString(),
    };
    // Non-Studio clients still write the shared store. Reject a login/removal
    // observed during the network request instead of restoring its old identity.
    const latest = JSON.parse(
      await readFile(filePath, "utf8"),
    ) as CredentialsFile;
    const current = latest.environments[env.name];
    if (
      current?.apiURL !== env.apiURL ||
      current.credentials?.apiKey !== env.credentials?.apiKey ||
      current.credentials?.studioCredentials?.refreshToken !==
        credentials.refreshToken
    )
      return null;
    current.credentials.studioCredentials = next;
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(latest, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, filePath);
    } finally {
      await rm(temporary, { force: true });
    }
    return next;
  });
}

/** Local sign-out is authoritative even if remote revocation is unavailable. */
export async function revokeStudioCredentials(
  env: ResolvedEnvironment,
): Promise<void> {
  const token = env.credentials?.studioCredentials?.accessToken;
  if (!token) return;
  try {
    await fetch(`${env.apiURL}/v1/studio/signout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
  } catch {
    /* Offline sign-out clears local access; the token family expires remotely. */
  }
}
