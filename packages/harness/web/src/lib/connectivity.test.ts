import { describe, expect, it } from "vitest";

import {
  AUTH_ERROR_STATUSES,
  classifyConnectivity,
  isAuthError,
  isNetworkError,
} from "./connectivity";

describe("isNetworkError", () => {
  it("is false for no error", () => {
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });

  it("is true for an explicit network-throw flag", () => {
    expect(isNetworkError({ networkError: true })).toBe(true);
  });

  it("treats a missing HTTP status as a network throw (fetch never got a response)", () => {
    expect(isNetworkError({})).toBe(true);
  });

  it("is false when the request reached the server (has a status)", () => {
    expect(isNetworkError({ status: 500 })).toBe(false);
    expect(isNetworkError({ status: 401 })).toBe(false);
  });
});

describe("isAuthError", () => {
  it("is true only for the credential-rejected statuses", () => {
    expect(isAuthError({ status: 401 })).toBe(true);
    expect(isAuthError({ status: 403 })).toBe(true);
  });

  it("is false for other statuses and for network throws", () => {
    expect(isAuthError({ status: 500 })).toBe(false);
    expect(isAuthError({ status: 404 })).toBe(false);
    expect(isAuthError({ networkError: true })).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });

  it("AUTH_ERROR_STATUSES is exactly {401, 403}", () => {
    expect([...AUTH_ERROR_STATUSES].sort()).toEqual([401, 403]);
  });
});

describe("classifyConnectivity", () => {
  it("online with no error is 'online'", () => {
    expect(classifyConnectivity({ online: true })).toBe("online");
    expect(classifyConnectivity({ online: true, error: null })).toBe("online");
  });

  it("the browser reporting offline is 'offline' regardless of any error", () => {
    expect(classifyConnectivity({ online: false })).toBe("offline");
    // Offline wins even over an auth error — an offline device can't re-auth.
    expect(
      classifyConnectivity({ online: false, error: { status: 401 } }),
    ).toBe("offline");
    expect(
      classifyConnectivity({ online: false, error: { status: 500 } }),
    ).toBe("offline");
  });

  it("a network-level throw while nominally online is still 'offline'", () => {
    expect(
      classifyConnectivity({ online: true, error: { networkError: true } }),
    ).toBe("offline");
    // A missing status is a network throw too (fetch rejected with no response).
    expect(classifyConnectivity({ online: true, error: {} })).toBe("offline");
  });

  it("a rejected credential (401/403) while online is the recoverable 'auth' state", () => {
    expect(classifyConnectivity({ online: true, error: { status: 401 } })).toBe(
      "auth",
    );
    expect(classifyConnectivity({ online: true, error: { status: 403 } })).toBe(
      "auth",
    );
  });

  it("any other server response while online is a generic 'error'", () => {
    expect(classifyConnectivity({ online: true, error: { status: 500 } })).toBe(
      "error",
    );
    expect(classifyConnectivity({ online: true, error: { status: 404 } })).toBe(
      "error",
    );
    expect(classifyConnectivity({ online: true, error: { status: 503 } })).toBe(
      "error",
    );
  });

  it("precedence is offline > auth > error > online", () => {
    // offline beats auth
    expect(
      classifyConnectivity({ online: false, error: { status: 403 } }),
    ).toBe("offline");
    // auth beats a plain error is not applicable (a single status is one or the
    // other) — but auth must beat the generic-error fallthrough for 401/403.
    expect(classifyConnectivity({ online: true, error: { status: 401 } })).toBe(
      "auth",
    );
    // a non-auth status falls through to error, not online.
    expect(classifyConnectivity({ online: true, error: { status: 418 } })).toBe(
      "error",
    );
  });
});
