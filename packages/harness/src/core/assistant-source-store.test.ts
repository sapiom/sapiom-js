import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AssistantContextError,
  assistantRevision,
  type AcceptedAssistantContext,
} from "@sapiom/opencode";
import { FileAssistantSourceStore } from "./assistant-source-store.js";
import {
  sourceFixture,
  sourceScope,
  acceptanceId,
  sourceContext,
} from "./test-fixtures/assistant-context.js";
import {
  acceptedAssistantRecord,
  createAssistantContextCandidate,
  createAssistantSource,
  encodeAssistantSkillPackage,
  retainAssistantGuidance,
} from "./assistant-sources.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), link: vi.fn(actual.link) };
});
const actual = await vi.importActual<typeof fs>("node:fs/promises");
const ref = ({
  context: _context,
  instructionSet: _instructions,
  ...reference
}: AcceptedAssistantContext) => reference;
const signal = () => new AbortController().signal;
let directory: string;
let store: FileAssistantSourceStore;
const root = () => join(directory, "assistant-context", "v1", sourceScope);
const manifest = () => join(root(), "accepted", `${acceptanceId}.json`);
async function retain(
  target = store,
  fixture = sourceFixture(),
  abort = signal(),
) {
  await target.retainAccepted(
    fixture.accepted,
    fixture.candidate.materials,
    fixture.authority,
    abort,
  );
  return fixture;
}
beforeEach(async () => {
  vi.mocked(fs.open).mockImplementation(actual.open);
  vi.mocked(fs.link).mockImplementation(actual.link);
  directory = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "assistant-store-")),
  );
  store = new FileAssistantSourceStore(directory, sourceScope);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("durable accepted Assistant sources", () => {
  it("reads exact retained text after restart and detaches returned data", async () => {
    const fixture = await retain();
    const restarted = new FileAssistantSourceStore(directory, sourceScope);
    const loaded = await restarted.readAccepted(
      ref(fixture.accepted),
      fixture.authority,
      signal(),
    );
    expect(loaded.accepted).toEqual(fixture.accepted);
    expect(loaded.sources.get("profile")).toEqual({
      format: "utf8",
      text: "Exact profile\r\nbytes",
    });
    (loaded.accepted.context as { environment: string }).environment =
      "changed";
    expect(
      (
        await restarted.readAccepted(
          ref(fixture.accepted),
          fixture.authority,
          signal(),
        )
      ).accepted,
    ).toEqual(fixture.accepted);
    if (process.platform !== "win32") {
      expect((await fs.stat(root())).mode & 0o777).toBe(0o700);
      expect((await fs.stat(manifest())).mode & 0o777).toBe(0o600);
    }
    expect(
      (await fs.readdir(join(root(), "accepted"))).filter((file) =>
        file.startsWith(".tmp"),
      ),
    ).toEqual([]);
  });
  it("preserves complete package resources and executable facts across restart", async () => {
    const context = sourceContext();
    const skill = createAssistantSource(
      {
        id: "skill",
        kind: "skill",
        required: true,
        source: "test:skill",
        authorityScope: sourceScope,
      },
      {
        format: "skill-package",
        bytes: encodeAssistantSkillPackage([
          {
            path: "SKILL.md",
            bytes: Buffer.from("Use the script"),
            executable: false,
          },
          {
            path: "bin/run",
            bytes: new Uint8Array([0, 255, 1]),
            executable: true,
          },
        ]),
      },
    );
    const candidate = createAssistantContextCandidate(context, sourceScope, [
      retainAssistantGuidance(context.guidance[0]!, sourceScope),
      {
        ...skill,
        metadata: {
          id: "skill",
          kind: "skill",
          required: true,
          source: "test:skill",
          status: "available",
          revision: null,
        },
      },
    ]);
    const accepted = acceptedAssistantRecord(
      candidate,
      sourceScope,
      "ses_fixture",
      acceptanceId,
    );
    const authority = sourceFixture().authority;
    await store.retainAccepted(
      accepted,
      candidate.materials,
      authority,
      signal(),
    );
    skill.material!.bytes.fill(0);
    const loaded = await new FileAssistantSourceStore(
      directory,
      sourceScope,
    ).readAccepted(ref(accepted), authority, signal());
    expect(loaded.sources.get("skill")).toMatchObject({
      format: "skill-package",
      members: [
        { path: "SKILL.md", executable: false },
        {
          path: "bin/run",
          bytes: new Uint8Array([0, 255, 1]),
          executable: true,
        },
      ],
    });
  });
  it("supports concurrent idempotent writers without replacing immutable targets", async () => {
    const fixture = sourceFixture();
    await Promise.all([
      retain(store, fixture),
      retain(new FileAssistantSourceStore(directory, sourceScope), fixture),
    ]);
    const before = await fs.stat(manifest());
    await retain(store, fixture);
    expect((await fs.stat(manifest())).ino).toBe(before.ino);
    const changed = structuredClone(fixture.accepted);
    (changed.context as { environment: string }).environment = "changed";
    (changed as { revision: string }).revision = assistantRevision(changed);
    await expect(
      store.retainAccepted(
        changed,
        fixture.candidate.materials,
        fixture.authority,
        signal(),
      ),
    ).rejects.toThrow(AssistantContextError);
    expect(
      (
        await store.readAccepted(
          ref(fixture.accepted),
          fixture.authority,
          signal(),
        )
      ).accepted,
    ).toEqual(fixture.accepted);
  });
  it("snapshots inputs before asynchronous publication", async () => {
    const fixture = sourceFixture();
    const expected = structuredClone(fixture.accepted);
    const pending = retain(store, fixture);
    fixture.candidate.materials[0]!.bytes.fill(0);
    (fixture.accepted.context as { environment: string }).environment =
      "mutated";
    fixture.authority.conversationId = "ses_changed";
    await pending;
    expect(
      (
        await store.readAccepted(
          ref(expected),
          sourceFixture().authority,
          signal(),
        )
      ).accepted,
    ).toEqual(expected);
  });
  it("rejects foreign scopes, conversations and malformed file keys before IO", async () => {
    const fixture = await retain();
    for (const reference of [
      { ...ref(fixture.accepted), authorityScope: "b".repeat(64) },
      { ...ref(fixture.accepted), conversationId: "ses_other" },
      { ...ref(fixture.accepted), acceptanceId: "../../escape" },
      { ...ref(fixture.accepted), revision: "b".repeat(64) },
    ])
      await expect(
        store.readAccepted(reference, fixture.authority, signal()),
      ).rejects.toThrow(AssistantContextError);
    await expect(
      store.readAccepted(
        ref(fixture.accepted),
        { ...fixture.authority, conversationId: "ses_other" },
        signal(),
      ),
    ).rejects.toThrow(AssistantContextError);
    expect(() => new FileAssistantSourceStore(directory, "../escape")).toThrow(
      AssistantContextError,
    );
  });
  it.each(["missing", "corrupt", "symlink"])(
    "rejects a %s object on read and idempotent publication",
    async (failure) => {
      const fixture = await retain();
      const source = fixture.accepted.instructionSet.sources[0]!;
      const object = join(root(), "objects", source.contentHash!);
      await fs.unlink(object);
      if (failure === "corrupt")
        await fs.writeFile(object, "corrupt", { mode: 0o600 });
      if (failure === "symlink") await fs.symlink(manifest(), object);
      await expect(
        store.readAccepted(ref(fixture.accepted), fixture.authority, signal()),
      ).rejects.toThrow(AssistantContextError);
      if (failure !== "missing")
        await expect(retain(store, fixture)).rejects.toThrow(
          AssistantContextError,
        );
    },
  );
  it("rejects manifest tampering and directory substitutions", async () => {
    const fixture = await retain();
    const saved = await fs.readFile(manifest());
    await fs.writeFile(manifest(), "{}");
    await expect(
      store.readAccepted(ref(fixture.accepted), fixture.authority, signal()),
    ).rejects.toThrow(AssistantContextError);
    await fs.writeFile(manifest(), saved);
    const objects = join(root(), "objects");
    await fs.rename(objects, `${objects}-original`);
    await fs.symlink(`${objects}-original`, objects, "dir");
    await expect(
      store.readAccepted(ref(fixture.accepted), fixture.authority, signal()),
    ).rejects.toThrow(AssistantContextError);
    await expect(retain(store, fixture)).rejects.toThrow(AssistantContextError);
  });
  it.each(["file", "directory"])(
    "does not acknowledge retention after %s fsync failure",
    async (kind) => {
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        const stat = await handle.stat();
        if (kind === "file" ? stat.isFile() : stat.isDirectory())
          handle.sync = async () => {
            throw new Error("injected sync failure");
          };
        return handle;
      });
      await expect(retain()).rejects.toThrow(AssistantContextError);
      await expect(fs.stat(manifest())).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
  it("checks cancellation before committing a manifest, leaving only unreferenced objects", async () => {
    const abort = new AbortController();
    vi.mocked(fs.link).mockImplementation(async (from, to) => {
      await actual.link(from, to);
      if (String(to).includes("/objects/")) abort.abort();
    });
    await expect(
      retain(store, sourceFixture(), abort.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(fs.stat(manifest())).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await fs.readdir(join(root(), "objects"))).some((file) =>
        file.startsWith(".tmp"),
      ),
    ).toBe(false);
  });
  it.each(["objects", "accepted"])(
    "requires the %s publication directory to sync before acknowledging",
    async (area) => {
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        if (String(args[0]) === join(root(), area))
          handle.sync = async () => {
            throw new Error("publication sync failed");
          };
        return handle;
      });
      await expect(retain()).rejects.toThrow(AssistantContextError);
      if (area === "objects")
        await expect(fs.stat(manifest())).rejects.toMatchObject({
          code: "ENOENT",
        });
      // A manifest linked before failed fsync may exist, but is never acknowledged.
      else expect((await fs.stat(manifest())).isFile()).toBe(true);
    },
  );
  it("rejects incomplete materials before creating the repository", async () => {
    const fixture = sourceFixture();
    await expect(
      store.retainAccepted(
        fixture.accepted,
        fixture.candidate.materials.slice(1),
        fixture.authority,
        signal(),
      ),
    ).rejects.toThrow(AssistantContextError);
    expect(await fs.readdir(directory)).toEqual([]);
  });
});
