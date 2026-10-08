import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  refreshStudioCredentials,
  withStudioCredentialLock,
  revokeStudioCredentials,
} from "./studio-credentials.js";
import type { ResolvedEnvironment } from "@sapiom/mcp/auth";

const store = vi.hoisted(() => ({ path: "" }));
vi.mock("@sapiom/mcp/auth", () => ({ credentialsFilePath: () => store.path }));
const fetchMock = vi.fn();
let directory: string;
let env: ResolvedEnvironment;
const freshPair = {
  access_token: "sat_new",
  refresh_token: "srt_new",
  expires_in: 3600,
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "studio-credentials-"));
  store.path = join(directory, "credentials.json");
  env = {
    name: "staging",
    apiURL: "https://api.sapiom.dev",
    appURL: "https://app.sapiom.dev",
    services: {},
    credentials: {
      apiKey: "sk_test",
      apiKeyId: "key",
      tenantId: "tenant",
      organizationName: "Org",
      studioCredentials: {
        accessToken: "sat_old",
        refreshToken: "srt_old",
        expiresAt: new Date().toISOString(),
      },
    },
  };
  await writeFile(
    store.path,
    JSON.stringify({
      currentEnvironment: env.name,
      environments: { [env.name]: env },
    }),
  );
  vi.stubGlobal(
    "fetch",
    fetchMock.mockReset().mockResolvedValue(Response.json(freshPair)),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

describe("Studio user credentials", () => {
  it("serializes concurrent rotation and atomically persists a private credential", async () => {
    const results = await Promise.all([
      refreshStudioCredentials(env),
      refreshStudioCredentials(env),
    ]);
    expect(results[0]?.accessToken).toBe("sat_new");
    expect(results[1]).toEqual(results[0]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.sapiom.dev/v1/tokens/refresh",
      expect.objectContaining({
        body: JSON.stringify({ refreshToken: "srt_old" }),
        redirect: "error",
      }),
    );
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });

  it("does not restore a login removed by another client while refresh is pending", async () => {
    fetchMock.mockImplementationOnce(async () => {
      await writeFile(store.path, JSON.stringify({ environments: {} }));
      return Response.json(freshPair);
    });
    expect(await refreshStudioCredentials(env)).toBeNull();
    expect(JSON.parse(await readFile(store.path, "utf8")).environments).toEqual(
      {},
    );
  });

  it("refuses to send credentials to a changed environment URL or for a changed key", async () => {
    expect(
      await refreshStudioCredentials({
        ...env,
        apiURL: "https://other.example",
      }),
    ).toBeNull();
    expect(
      await refreshStudioCredentials({
        ...env,
        credentials: { ...env.credentials!, apiKey: "another" },
      }),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails without exposing response bodies and preserves the file on denied refresh", async () => {
    fetchMock.mockResolvedValue(
      new Response("private diagnostic", { status: 401 }),
    );
    await expect(refreshStudioCredentials(env)).rejects.toThrow(
      "Sign in again",
    );
    expect(await readFile(store.path, "utf8")).toContain("srt_old");
  });

  it.each([
    [new Response("private diagnostic", { status: 503 }), "transient"],
    [new TypeError("private network diagnostic"), "transient"],
    [new Response("private diagnostic", { status: 429 }), "rejected"],
  ])(
    "classifies only network and 5xx refresh failures as transient",
    async (failure, kind) => {
      if (failure instanceof Response) fetchMock.mockResolvedValue(failure);
      else fetchMock.mockRejectedValue(failure);
      await expect(refreshStudioCredentials(env)).rejects.toMatchObject({
        kind,
      });
      expect(await readFile(store.path, "utf8")).toContain("srt_old");
    },
  );

  it("waits for an existing Studio credential mutation before reading", async () => {
    let release!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const mutation = withStudioCredentialLock(async () => {
      locked();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await acquired;
    const refresh = refreshStudioCredentials(env);
    expect(fetchMock).not.toHaveBeenCalled();
    release();
    await mutation;
    await refresh;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("best-effort revokes the user family on sign-out without leaking tokens into errors", async () => {
    await revokeStudioCredentials(env);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.sapiom.dev/v1/studio/signout",
      expect.objectContaining({
        headers: { Authorization: "Bearer sat_old" },
        method: "POST",
        redirect: "error",
      }),
    );
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(revokeStudioCredentials(env)).resolves.toBeUndefined();
  });
});
