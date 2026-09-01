import {
  cloneRequest,
  copySapiomMetadata,
  readSapiomMetadata,
  requestFromInput,
} from "./sapiom-request";

describe("sapiom-request metadata", () => {
  it("reads __sapiom from Request input before cloning", () => {
    const original = new Request("https://example.test/public");
    (original as any).__sapiom = { enabled: false };

    expect(readSapiomMetadata(original)).toEqual({ enabled: false });
    expect(readSapiomMetadata("https://example.test")).toBeUndefined();
  });

  it("carries __sapiom through requestFromInput", () => {
    const original = new Request("https://example.test/public");
    (original as any).__sapiom = { enabled: false, serviceName: "demo" };

    const copy = requestFromInput(original);

    expect((copy as any).__sapiom).toEqual({
      enabled: false,
      serviceName: "demo",
    });
  });

  it("carries __sapiom through cloneRequest", () => {
    const original = new Request("https://example.test/api");
    (original as any).__sapiom = { actionName: "fetch" };

    const headers = new Headers(original.headers);
    headers.set("X-Test", "1");
    const cloned = cloneRequest(original, { headers });

    expect((cloned as any).__sapiom).toEqual({ actionName: "fetch" });
    expect(cloned.headers.get("X-Test")).toBe("1");
  });

  it("matches issue #690 reproduction shape", () => {
    const original = new Request("https://example.test/public");
    (original as any).__sapiom = { enabled: false };

    const copy = new Request(original);
    copySapiomMetadata(original, copy);

    expect((original as any).__sapiom).toEqual({ enabled: false });
    expect((copy as any).__sapiom).toEqual({ enabled: false });
    expect(Object.prototype.hasOwnProperty.call(copy, "__sapiom")).toBe(true);
  });
});
