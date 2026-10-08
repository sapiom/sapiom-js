import { createClient } from "../client.js";
import { DatabaseHttpError } from "../database/errors.js";
import { DomainsHttpError } from "../domains/errors.js";
import { FileStorageHttpError } from "../file-storage/errors.js";
import { executionDeliveryEligible } from "./execution-delivery.js";

type Client = ReturnType<typeof createClient>;
const database = {
  id: "db-fixture",
  handle: "analytics",
  status: "active",
  region: "us-east-1",
  pgVersion: 17,
  connectionUri:
    "postgresql://user:fixture%21@db.test:5433/app?sslmode=require",
  createdAt: "2026-09-23T00:00:00Z",
};
const domain = {
  domainName: "example.test",
  locked: false,
  premium: false,
  purchasePrice: "12.50",
  nameservers: ["ns.test"],
};
const upload = {
  fileId: "file-fixture",
  uploadUrl: "https://storage.test/upload?signature=fixture",
  requiredHeaders: {
    "Content-Type": "text/plain",
    "x-goog-meta-test": "fixture",
  },
  expiresAt: "2026-09-23T00:15:00Z",
};
const cases: {
  id: string;
  call: (client: Client) => Promise<unknown>;
  result: unknown;
  legacy: unknown;
  request: object;
  error: typeof DatabaseHttpError;
  path: string;
}[] = [
  {
    id: "database.create",
    call: (c) =>
      c.database.create({ handle: "analytics", pgVersion: 17, duration: "1h" }),
    result: database,
    legacy: database,
    request: { handle: "analytics", pgVersion: 17 },
    error: DatabaseHttpError,
    path: "/v1/databases",
  },
  {
    id: "domains.purchase",
    call: (c) => c.domains.register({ domainName: "example.test" }),
    result: domain,
    legacy: domain,
    request: { domainName: "example.test" },
    error: DomainsHttpError,
    path: "/v1/domains",
  },
  {
    id: "storage.put",
    call: (c) =>
      c.fileStorage.upload({
        contentType: "text/plain",
        fileSize: 12,
        fileName: "file.txt",
        visibility: "private",
      }),
    result: upload,
    legacy: {
      file_id: upload.fileId,
      upload_url: upload.uploadUrl,
      required_headers: upload.requiredHeaders,
      expires_at: upload.expiresAt,
    },
    request: {
      contentType: "text/plain",
      fileSize: 12,
      fileName: "file.txt",
      visibility: "private",
    },
    error: FileStorageHttpError,
    path: "/upload",
  },
];
const receipt = (id: string) => ({
  version: 1,
  id: "11111111-1111-4111-8111-111111111111",
  capabilityId: id,
  status: "queued",
  createdAt: "2026-09-23T00:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z",
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("resource adoption", () => {
  it.each(cases)(
    "preserves $id mapping without another provision/reservation",
    async (fixture) => {
      const results = [];
      for (const capabilityDelivery of ["legacy", "executions"] as const) {
        const calls: { url: string; init: RequestInit }[] = [];
        const saved = receipt(fixture.id);
        const client = createClient({
          apiKey: "fixture",
          coreBaseUrl: "https://core.test",
          capabilityDelivery,
          fetch: async (url, init) => {
            calls.push({ url: String(url), init: init! });
            return json(
              String(url).endsWith("/executions")
                ? saved
                : String(url).includes("/capability-executions/")
                  ? { ...saved, status: "succeeded", result: fixture.result }
                  : fixture.legacy,
            );
          },
        });
        results.push(await fixture.call(client));
        expect(calls).toHaveLength(capabilityDelivery === "executions" ? 2 : 1);
        expect(
          calls.filter((call) => call.init.method === "POST"),
        ).toHaveLength(1);
        if (capabilityDelivery === "executions") {
          expect(calls[0].url).toBe(
            `https://core.test/v1/capabilities/${fixture.id}/executions`,
          );
          expect(JSON.parse(String(calls[0].init.body))).toEqual(
            fixture.request,
          );
        } else expect(new URL(calls[0].url).pathname).toBe(fixture.path);
      }
      expect(results[1]).toEqual(results[0]);
      if (fixture.id === "database.create")
        expect(results[1]).toMatchObject({
          connection: { password: "fixture!", port: 5433, sslmode: "require" },
        });
      if (fixture.id === "storage.put") expect(results[1]).toEqual(upload);
      expect(executionDeliveryEligible(fixture.id)).toBe(true);
    },
  );

  it.each(cases)(
    "does not fall back from admission rejection for $id",
    async (fixture) => {
      const urls: string[] = [];
      const client = createClient({
        apiKey: "fixture",
        coreBaseUrl: "https://core.test",
        capabilityDelivery: "executions",
        fetch: async (url) => {
          urls.push(String(url));
          return json({ code: "admission_disabled" }, 503);
        },
      });
      await expect(fixture.call(client)).rejects.toBeInstanceOf(fixture.error);
      expect(urls).toEqual([
        `https://core.test/v1/capabilities/${fixture.id}/executions`,
      ]);
    },
  );

  it("leaves database/domain/file lifecycle reads and mutations on their existing service paths", async () => {
    const urls: string[] = [];
    const client = createClient({
      apiKey: "fixture",
      coreBaseUrl: "https://core.test",
      capabilityDelivery: "executions",
      fetch: async (url) => {
        urls.push(String(url));
        return json(String(url).includes('/files') ? { files: [], limit: 20, offset: 0, has_more: false } : []);
      },
    });
    await client.database.list();
    await client.domains.list();
    await client.fileStorage.list();
    expect(urls).toHaveLength(3);
    expect(
      urls.every(
        (url) => !url.includes("core.test") && !url.includes("/executions"),
      ),
    ).toBe(true);
    for (const id of [
      "decisions.evaluate",
      "database.delete",
      "domains.renew",
      "storage.uploadBytes",
      "unknown",
    ])
      expect(executionDeliveryEligible(id)).toBe(false);
  });
});
