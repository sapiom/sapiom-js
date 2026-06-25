import { resolveServiceUrl } from "./service-url.js";

describe("resolveServiceUrl", () => {
  const ORIGINAL = process.env.SAPIOM_SERVICES_BASE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SAPIOM_SERVICES_BASE;
    else process.env.SAPIOM_SERVICES_BASE = ORIGINAL;
  });

  it("falls back to the production default when nothing is set", () => {
    delete process.env.SAPIOM_SERVICES_BASE;
    expect(resolveServiceUrl("fal")).toBe("https://fal.services.sapiom.ai");
    expect(resolveServiceUrl("git")).toBe("https://git.services.sapiom.ai");
  });

  it("a per-capability override always wins", () => {
    process.env.SAPIOM_SERVICES_BASE = "http://services.localhost:3100";
    expect(resolveServiceUrl("fal", "http://custom:9999")).toBe(
      "http://custom:9999",
    );
  });

  it("SAPIOM_SERVICES_BASE re-homes every capability by injecting its subdomain", () => {
    process.env.SAPIOM_SERVICES_BASE = "http://services.localhost:3100";
    expect(resolveServiceUrl("fal")).toBe("http://fal.services.localhost:3100");
    expect(resolveServiceUrl("file-storage")).toBe(
      "http://file-storage.services.localhost:3100",
    );
    expect(resolveServiceUrl("git")).toBe("http://git.services.localhost:3100");
  });

  it("accepts a bare host[:port] (assumes https) as well as a full origin", () => {
    process.env.SAPIOM_SERVICES_BASE = "services.localhost:3100";
    expect(resolveServiceUrl("agents")).toBe(
      "https://agents.services.localhost:3100",
    );
  });

  it("uses only scheme + host[:port] from the base (ignores any path)", () => {
    process.env.SAPIOM_SERVICES_BASE = "http://services.localhost:3100/ignored";
    expect(resolveServiceUrl("blaxel")).toBe(
      "http://blaxel.services.localhost:3100",
    );
  });
});
