/**
 * The stub Postgres DSN must be unroutable.
 *
 * `database.get` succeeds under `run_local`, but templates hold their own `pg`
 * client and dial what it returns. When the stub pointed at `localhost:5432`
 * that dial reached whatever Postgres the author happened to be running — the
 * dev stack's own server — and failed with an opaque TLS error that named
 * nothing (SAP-2909). Pinning the host to the RFC 6761 `.invalid` TLD means the
 * dial cannot leave the machine: it fails at DNS, before a socket is opened,
 * with the stub named in the error.
 */
import { createStubClient } from "./index.js";

/** RFC 6761 §6.4 guarantees `.invalid` never resolves. */
const UNROUTABLE = /\.invalid$/;

describe("stub database DSN is unroutable", () => {
  it("database.get returns a host that cannot resolve", async () => {
    const db = await createStubClient({}).database.get("my-handle");

    expect(db.connection?.host).toMatch(UNROUTABLE);
    expect(db.connection?.connectionString).toContain(".invalid:5432");
  });

  it("database.create returns a host that cannot resolve", async () => {
    const db = await createStubClient({}).database.create({ duration: "1h" });

    expect(db.connection?.host).toMatch(UNROUTABLE);
    expect(db.connection?.connectionString).toContain(".invalid:5432");
  });

  it("names the stub in the host, so a failed dial says where the DSN came from", async () => {
    const db = await createStubClient({}).database.get("my-handle");

    // The dial fails as `getaddrinfo ENOTFOUND <host>`; the host is the only
    // part of that message we control, so it has to carry the explanation.
    expect(db.connection?.host).toContain("stub");
  });

  it("never points at localhost — the author's own Postgres", async () => {
    const client = createStubClient({});
    const got = await client.database.get("my-handle");
    const created = await client.database.create({ duration: "1h" });

    for (const conn of [got.connection, created.connection]) {
      expect(conn?.host).not.toBe("localhost");
      expect(conn?.connectionString).not.toContain("localhost");
    }
  });

  it("still lets an override supply a real DSN for a test that wants one", async () => {
    const real = { connection: { host: "db.example.com", port: 5432 } };
    const client = createStubClient({ overrides: { "database.get": real } });

    expect((await client.database.get("my-handle")).connection?.host).toBe(
      "db.example.com",
    );
  });
});
