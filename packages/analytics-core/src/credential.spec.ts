import { createHash, type BinaryToTextEncoding } from "node:crypto";

import {
  ALLOW_INSECURE_HTTP_ENV,
  CredentialChannelError,
  assertCredentialMayTravel,
  credentialFetch,
  isLoopbackHostname,
  matchesIntegrity,
  mayCarryCredential,
  resolveCredentialPolicy,
  withoutBodyHeaders,
  withoutCrossOriginHeaders,
} from "./credential.js";

const WORDING = {
  label: "@sapiom/test",
  optIn: "createClient({ allowInsecureHttp: true })",
};
const STRICT = { allowInsecureHttp: false, ...WORDING };
const OPTED_IN = { allowInsecureHttp: true, ...WORDING };

describe("isLoopbackHostname", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "api.localhost",
    "fal.services.localhost",
    "127.0.0.1",
    "127.1.2.3",
    "[::1]",
  ])("%s is loopback", (host) => {
    expect(isLoopbackHostname(host)).toBe(true);
  });

  it.each([
    "api",
    "host.docker.internal",
    "10.0.0.5",
    "192.168.1.10",
    "localhost.evil.com",
    "evil-localhost",
    "127.0.0.1.nip.io",
    "0.0.0.0",
    "[::ffff:7f00:1]",
  ])("%s is not loopback", (host) => {
    expect(isLoopbackHostname(host)).toBe(false);
  });
});

describe("assertCredentialMayTravel", () => {
  const check =
    (url: string, policy = STRICT) =>
    () =>
      assertCredentialMayTravel(new URL(url), policy);

  it.each([
    "https://api.sapiom.ai/v1/memory",
    "https://10.0.0.5/x",
    "http://localhost:3000/v1",
    "http://fal.services.localhost:3100/v1",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
    // The URL parser canonicalizes these to 127.0.0.1.
    "http://127.1/",
    "http://2130706433/",
  ])("allows %s", (url) => {
    expect(check(url)).not.toThrow();
  });

  it("refuses plaintext to a non-loopback host, naming the opt-in", () => {
    expect(check("http://api:3000/v1")).toThrow(
      /refusing plaintext HTTP to http:\/\/api:3000.*SAPIOM_ALLOW_INSECURE_HTTP=1/,
    );
  });

  it("names the label, the client's opt-in and the env var", () => {
    expect(check("http://api.internal/v1")).toThrow(
      "@sapiom/test: refusing plaintext HTTP to http://api.internal. " +
        "The tenant API key only travels over https or to a loopback host " +
        "(localhost, *.localhost, 127.0.0.1, [::1]). For a trusted private network, " +
        "opt in with createClient({ allowInsecureHttp: true }) or SAPIOM_ALLOW_INSECURE_HTTP=1.",
    );
  });

  it("names only the env var when the client has no opt-in of its own", () => {
    expect(() =>
      assertCredentialMayTravel(new URL("http://api.internal/v1"), {
        allowInsecureHttp: false,
        label: "@sapiom/mcp",
      }),
    ).toThrow(/^@sapiom\/mcp: .*opt in with SAPIOM_ALLOW_INSECURE_HTTP=1\.$/);
  });

  it("allows plaintext to a non-loopback host once opted in", () => {
    expect(check("http://api:3000/v1", OPTED_IN)).not.toThrow();
  });

  it.each(["gopher://api.sapiom.ai/", "file:///etc/passwd", "ws://localhost/"])(
    "refuses %s even when opted in",
    (url) => {
      expect(check(url, OPTED_IN)).toThrow(/expected http or https/);
    },
  );

  it("throws a TypeError with no cause, and never echoes the path or query", () => {
    let thrown: unknown;
    try {
      check("http://api:3000/secret/path?token=abc")();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CredentialChannelError);
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).name).toBe("TypeError");
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
    expect((thrown as Error).message).not.toMatch(/secret|token=abc/);
  });

  it("names the origin a refused redirect came from", () => {
    expect(() =>
      assertCredentialMayTravel(
        new URL("http://evil:3000/landed"),
        STRICT,
        new URL("https://api.sapiom.ai/v1/x"),
      ),
    ).toThrow("(redirected from https://api.sapiom.ai)");
  });
});

describe("mayCarryCredential", () => {
  it.each([
    "https://api.internal/",
    "http://localhost:3000/",
    "http://vault.localhost:3999/",
    "http://127.0.0.5/",
    "http://[::1]:3000/",
  ])("%s may carry the key", (url) => {
    expect(mayCarryCredential(new URL(url), STRICT)).toBe(true);
  });

  it("plaintext to a non-loopback host may not, unless opted in", () => {
    expect(mayCarryCredential(new URL("http://api.internal/"), STRICT)).toBe(
      false,
    );
    expect(mayCarryCredential(new URL("http://api.internal/"), OPTED_IN)).toBe(
      true,
    );
  });

  it("another scheme may not, even opted in", () => {
    expect(mayCarryCredential(new URL("ws://localhost/"), OPTED_IN)).toBe(
      false,
    );
  });
});

describe("resolveCredentialPolicy", () => {
  const ORIGINAL = process.env[ALLOW_INSECURE_HTTP_ENV];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[ALLOW_INSECURE_HTTP_ENV];
    else process.env[ALLOW_INSECURE_HTTP_ENV] = ORIGINAL;
  });

  it("is strict when nothing is set", () => {
    delete process.env[ALLOW_INSECURE_HTTP_ENV];
    expect(resolveCredentialPolicy(undefined, WORDING).allowInsecureHttp).toBe(
      false,
    );
  });

  it.each([
    ["1", true],
    ["true", true],
    [" TRUE ", true],
    ["0", false],
    ["false", false],
    ["", false],
  ])("env %j opts in: %s", (value, expected) => {
    process.env[ALLOW_INSECURE_HTTP_ENV] = value;
    expect(resolveCredentialPolicy(undefined, WORDING).allowInsecureHttp).toBe(
      expected,
    );
  });

  it("carries the client's wording", () => {
    expect(resolveCredentialPolicy(undefined, WORDING)).toMatchObject(WORDING);
  });

  it("an explicit value beats the env", () => {
    process.env[ALLOW_INSECURE_HTTP_ENV] = "1";
    expect(resolveCredentialPolicy(false, WORDING).allowInsecureHttp).toBe(
      false,
    );
    delete process.env[ALLOW_INSECURE_HTTP_ENV];
    expect(resolveCredentialPolicy(true, WORDING).allowInsecureHttp).toBe(true);
  });
});

describe("withoutCrossOriginHeaders", () => {
  it("drops the credential, every x-sapiom-* header, and what fetch drops itself", () => {
    expect(
      withoutCrossOriginHeaders({
        "x-sapiom-api-key": "k",
        "X-Api-Key": "k",
        "x-sapiom-client": "sapiom-tools/1",
        "X-Sapiom-Workflow-Token": "t",
        authorization: "Bearer a",
        "Proxy-Authorization": "Basic p",
        cookie: "c=1",
        host: "api.sapiom.ai",
        accept: "application/json",
        "content-type": "application/json",
      }),
    ).toEqual({
      accept: "application/json",
      "content-type": "application/json",
    });
  });
});

describe("withoutBodyHeaders", () => {
  it("drops the request-body headers only", () => {
    expect(
      withoutBodyHeaders({
        "Content-Type": "application/json",
        "content-length": "5",
        "content-encoding": "gzip",
        "content-language": "en",
        "content-location": "/x",
        accept: "application/json",
        "x-sapiom-api-key": "k",
      }),
    ).toEqual({ accept: "application/json", "x-sapiom-api-key": "k" });
  });
});

describe("matchesIntegrity", () => {
  const BODY = new TextEncoder().encode('{"ok":true}');
  const digest = (
    algorithm: string,
    encoding: BinaryToTextEncoding = "base64",
    body: Uint8Array = BODY,
  ) => createHash(algorithm).update(body).digest(encoding);
  const OTHER = new TextEncoder().encode("other");

  it.each([
    ["sha256", `sha256-${digest("sha256")}`],
    ["sha384", `sha384-${digest("sha384")}`],
    ["sha512", `sha512-${digest("sha512")}`],
    ["an uppercase algorithm", `SHA256-${digest("sha256")}`],
    ["a base64url digest", `sha256-${digest("sha256", "base64url")}`],
    [
      "a digest without its = padding",
      `sha256-${digest("sha256").replace(/=+$/, "")}`,
    ],
    ["a token with ?options", `sha256-${digest("sha256")}?ct=application/json`],
    [
      "any one digest of the strongest algorithm",
      `sha512-${digest("sha512", "base64", OTHER)}\tsha512-${digest("sha512")}`,
    ],
    ["metadata naming only unknown algorithms", "md5-abc sha1-def"],
    ["blank metadata", "  "],
  ])("matches %s", (_label, metadata) => {
    expect(matchesIntegrity(BODY, metadata)).toBe(true);
  });

  it.each([
    ["a wrong digest", `sha256-${digest("sha256", "base64", OTHER)}`],
    [
      "a weaker match next to a wrong stronger digest",
      `sha256-${digest("sha256")} sha384-${digest("sha384", "base64", OTHER)}`,
    ],
    ["an empty digest for a known algorithm", "sha256-"],
    ["a malformed digest for a known algorithm", "sha256-!!!"],
  ])("rejects %s", (_label, metadata) => {
    expect(matchesIntegrity(BODY, metadata)).toBe(false);
  });
});

describe("credentialFetch", () => {
  type Call = { url: string; headers: Record<string, string> };
  const recorder = (...responses: unknown[]) => {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return responses.shift();
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };
  const KEY = { header: "x-api-key", value: "sk_real" } as const;

  it("sets the key after the caller's headers, which cannot forge it", async () => {
    const { calls, fetchImpl } = recorder(new Response("ok"));
    await credentialFetch(
      fetchImpl,
      "https://api.example/x",
      { headers: { "X-Api-Key": "forged", accept: "application/json" } },
      KEY,
      STRICT,
    );
    expect(calls[0].headers).toEqual({
      accept: "application/json",
      "x-api-key": "sk_real",
    });
  });

  it.each([
    ["a Headers instance", new Headers({ "content-type": "application/json" })],
    [
      "a tuple list",
      [["content-type", "application/json"]] as [string, string][],
    ],
  ])("reads caller headers given as %s", async (_label, headers) => {
    const { calls, fetchImpl } = recorder(new Response("ok"));
    await credentialFetch(
      fetchImpl,
      "https://api.example/x",
      { headers },
      KEY,
      STRICT,
    );
    expect(calls[0].headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "sk_real",
    });
  });

  it("refuses an untrusted channel before calling fetch", async () => {
    const { calls, fetchImpl } = recorder();
    await expect(
      credentialFetch(fetchImpl, "http://api.internal/x", {}, KEY, STRICT),
    ).rejects.toBeInstanceOf(CredentialChannelError);
    expect(calls).toHaveLength(0);
  });

  it("without a credential, sends no key and does not check the first URL", async () => {
    const { calls, fetchImpl } = recorder(new Response("ok"));
    await credentialFetch(
      fetchImpl,
      "http://api.internal/x",
      { headers: { accept: "*/*" } },
      undefined,
      STRICT,
    );
    expect(calls).toEqual([
      { url: "http://api.internal/x", headers: { accept: "*/*" } },
    ]);
  });

  it("returns a minimal redirect with no headers as is, after one call", async () => {
    const minimal = { ok: false, status: 307 };
    const { calls, fetchImpl } = recorder(minimal);
    await expect(
      credentialFetch(fetchImpl, "https://api.example/x", {}, KEY, STRICT),
    ).resolves.toBe(minimal);
    expect(calls).toHaveLength(1);
  });

  it("follows a minimal redirect carrying headers to a response with no clone", async () => {
    const { calls, fetchImpl } = recorder(
      {
        ok: false,
        status: 307,
        headers: new Headers({ location: "https://other.example/y" }),
      },
      { ok: true, status: 202 },
    );
    const response = await credentialFetch(
      fetchImpl,
      "https://api.example/x",
      {},
      KEY,
      STRICT,
    );
    expect(response).toMatchObject({ ok: true, status: 202, redirected: true });
    expect(calls.map((c) => c.headers["x-api-key"])).toEqual([
      "sk_real",
      undefined,
    ]);
  });
});
