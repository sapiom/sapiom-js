import { createStubClient } from "../stub/index.js";
import { SearchIndexHttpError } from "./index.js";

const searchIndexInfo = (id: string, name: string) => ({
  id,
  name,
  status: "active" as const,
  url: `https://${id}.search.data.stub.invalid`,
  region: null,
  expiresAt: null,
  createdAt: "2026-08-04T00:00:00.000Z",
});

describe("searchindex stateful stub", () => {
  it("generates deterministic resource IDs compatible with every SearchIndex surface", async () => {
    const firstClient = createStubClient();
    const first = await firstClient.searchindex.create({ name: "first" });
    const second = await firstClient.searchindex.create({ name: "second" });
    const repeatedClient = createStubClient();
    const repeated = await repeatedClient.searchindex.create({ name: "first" });

    expect(first.id).toBe("res_00000000000000000001");
    expect(second.id).toBe("res_00000000000000000002");
    expect(repeated.id).toBe(first.id);
    expect(first.id).toMatch(/^res_[a-z0-9]{20}$/);
    expect(first.url).toBe(`https://${first.id}.search.data.stub.invalid`);
    await expect(firstClient.searchindex.get(first.id)).resolves.toMatchObject({
      id: first.id,
    });
  });

  it("coerces plain JSON control-plane overrides into registry-backed handles", async () => {
    const createdId = "res_0000000000000000000a";
    const fetchedId = "res_0000000000000000000b";
    const listedId = "res_0000000000000000000c";
    const sapiom = createStubClient({
      overrides: {
        "searchindex.create": searchIndexInfo(createdId, "created override"),
        "searchindex.get": (id: unknown) =>
          searchIndexInfo(String(id), "get override"),
        "searchindex.list": [searchIndexInfo(listedId, "listed override")],
        "searchindex.update": searchIndexInfo(createdId, "updated override"),
      },
    });

    const created = await sapiom.searchindex.create({ name: "ignored" });
    expect(created).toMatchObject({ id: createdId, name: "created override" });
    expect(typeof created.upsert).toBe("function");
    await created.upsert([{ id: "created-doc", content: { body: "kept" } }]);

    const fetched = await sapiom.searchindex.get(fetchedId);
    expect(fetched).toMatchObject({ id: fetchedId, name: "get override" });
    expect(typeof fetched.query).toBe("function");
    await fetched.upsert([{ id: "fetched-doc", content: { body: "found" } }]);
    await expect(fetched.query({ query: "found" })).resolves.toMatchObject([
      { id: "fetched-doc" },
    ]);

    const listed = await sapiom.searchindex.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: listedId, name: "listed override" });
    expect(typeof listed[0]!.range).toBe("function");
    await listed[0]!.upsert([
      { id: "listed-doc", content: { body: "listed" } },
    ]);
    await expect(
      listed[0]!.range({ includeData: true }),
    ).resolves.toMatchObject({
      documents: [{ id: "listed-doc", content: { body: "listed" } }],
    });

    const updated = await sapiom.searchindex.update(createdId, {
      name: "requested update",
    });
    expect(updated).toMatchObject({ id: createdId, name: "updated override" });
    expect(typeof updated.fetchDocuments).toBe("function");
    await expect(
      updated.fetchDocuments(["created-doc"], { includeData: true }),
    ).resolves.toEqual([{ id: "created-doc", content: { body: "kept" } }]);
  });

  it("matches pagination and payload-inclusion semantics", async () => {
    const sapiom = createStubClient();
    const index = await sapiom.searchindex.create({
      name: "docs-corpus",
      region: "eu-west-1",
      ttl: "7d",
    });

    expect(index.region).toBe("eu-west-1");
    expect(index.expiresAt).not.toBeNull();
    await index.upsert([
      {
        id: "a",
        content: { title: "Alpha" },
        metadata: { contentHash: "h1" },
      },
      {
        id: "b",
        content: { title: "Beta" },
        metadata: { contentHash: "h2" },
      },
      {
        id: "c",
        content: { title: "Gamma" },
        metadata: { contentHash: "h3" },
      },
    ]);

    const first = await index.range({ limit: 2 });
    expect(first).toEqual({
      nextCursor: "2",
      documents: [{ id: "a" }, { id: "b" }],
    });

    const second = await index.range({
      cursor: first.nextCursor!,
      limit: 2,
      includeMetadata: true,
      includeData: true,
    });
    expect(second).toEqual({
      nextCursor: null,
      documents: [
        {
          id: "c",
          content: { title: "Gamma" },
          metadata: { contentHash: "h3" },
        },
      ],
    });

    await expect(
      index.fetchDocuments(["a", "missing"], { includeMetadata: true }),
    ).resolves.toEqual([{ id: "a", metadata: { contentHash: "h1" } }, null]);
    await expect(index.query({ query: "beta" })).resolves.toMatchObject([
      { id: "b", content: { title: "Beta" }, score: 1 },
    ]);
  });

  it("uses the same fail-fast validation matrix as the live client", async () => {
    const sapiom = createStubClient();
    await expect(sapiom.searchindex.create({ name: "" })).rejects.toMatchObject(
      {
        status: 400,
      },
    );
    await expect(
      sapiom.searchindex.create({ name: "docs", ttl: "31d" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(sapiom.searchindex.get("")).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      sapiom.searchindex.update("", { name: "docs" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(sapiom.searchindex.delete("")).rejects.toMatchObject({
      status: 400,
    });

    const index = await sapiom.searchindex.create({ name: "docs" });
    await expect(index.upsert([])).rejects.toMatchObject({ status: 400 });
    await expect(
      index.upsert([{ id: "bad", content: null } as never]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      index.upsert([{ id: "bad", content: {} }], { indexName: "bad name!" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(index.query({ query: " ", limit: 0 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(index.range({ cursor: "" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(index.range({ limit: 1001 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      index.range({ includeMetadata: "yes" } as never),
    ).rejects.toMatchObject({ status: 400 });
    await expect(index.fetchDocuments([])).rejects.toMatchObject({
      status: 400,
    });
    await expect(index.fetchDocuments([""])).rejects.toMatchObject({
      status: 400,
    });
    await expect(index.deleteDocuments([""])).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      sapiom.searchindex.update(index.id, { name: "" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      sapiom.searchindex.update(index.id, {
        expiresAt: "January 1, 2099",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("returns 404 for unknown resources and invalidates handles after deletion", async () => {
    const sapiom = createStubClient();
    await expect(sapiom.searchindex.get("res_missing")).rejects.toEqual(
      expect.objectContaining({ name: "SearchIndexHttpError", status: 404 }),
    );
    await expect(
      sapiom.searchindex.update("res_missing", { name: "renamed" }),
    ).rejects.toBeInstanceOf(SearchIndexHttpError);
    await expect(
      sapiom.searchindex.delete("res_missing"),
    ).rejects.toMatchObject({
      status: 404,
    });

    const index = await sapiom.searchindex.create({ name: "docs" });
    await sapiom.searchindex.delete(index.id);
    const staleHandleCalls = [
      () => index.upsert([{ id: "a", content: {} }]),
      () => index.query({ query: "anything" }),
      () => index.range(),
      () => index.fetchDocuments(["a"]),
      () => index.deleteDocuments(["a"]),
    ];
    for (const call of staleHandleCalls) {
      await expect(call()).rejects.toMatchObject({ status: 404 });
    }
    // The live control plane treats a repeated delete of the same retained row
    // as an idempotent terminal retry.
    await expect(sapiom.searchindex.delete(index.id)).resolves.toBeUndefined();
  });
});
