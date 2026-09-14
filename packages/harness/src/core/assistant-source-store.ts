import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { isAbsolute, join, dirname, resolve } from "node:path";
import {
  AssistantContextError,
  assistantContentHash,
  assistantContextLimits,
  encodeAssistantContext,
  validateAcceptedAssistantContext,
  validateAcceptedContextRef,
  type AcceptedAssistantContext,
  type AcceptedContextRef,
} from "@sapiom/opencode";
import {
  validateAssistantMaterials,
  type ReadonlySourceContent,
  type SourceMaterial,
} from "./assistant-sources.js";

export interface HostAuthority {
  readonly authorityScope: string;
  readonly conversationId: string;
}
export interface RetainedAssistantContext {
  readonly accepted: AcceptedAssistantContext;
  readonly sources: ReadonlyMap<string, ReadonlySourceContent>;
}
export interface AssistantSourceStore {
  retainAccepted(
    accepted: AcceptedAssistantContext,
    materials: readonly SourceMaterial[],
    authority: HostAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  readAccepted(
    reference: AcceptedContextRef,
    authority: HostAuthority,
    signal: AbortSignal,
  ): Promise<RetainedAssistantContext>;
}

const check: (valid: unknown) => asserts valid = (valid) => {
  if (!valid) throw new AssistantContextError();
};
const isCode = (error: unknown, code: string) =>
  (error as NodeJS.ErrnoException)?.code === code;
const referenceOf = ({
  context: _context,
  instructionSet: _instructions,
  ...reference
}: AcceptedAssistantContext) => reference;

/** Private, immutable materials with a manifest-last acceptance commit.
 * Unsupported directory fsync fails closed; no weaker Windows durability promise.
 * Retained objects outlive host shutdown and are never garbage-collected here. */
export class FileAssistantSourceStore implements AssistantSourceStore {
  private readonly stateRoot: string;
  constructor(
    stateRoot: string,
    private readonly authorityScope: string,
  ) {
    check(isAbsolute(stateRoot) && /^[a-f0-9]{64}$/.test(authorityScope));
    this.stateRoot = resolve(stateRoot);
  }

  async retainAccepted(
    accepted: AcceptedAssistantContext,
    materials: readonly SourceMaterial[],
    authority: HostAuthority,
    signal: AbortSignal,
  ): Promise<void> {
    return this.safe(signal, async () => {
      validateAcceptedAssistantContext(accepted);
      // Snapshot all caller-owned values before the first await.
      const record = JSON.parse(
        encodeAssistantContext(accepted),
      ) as AcceptedAssistantContext;
      const ref = referenceOf(record);
      this.authorize(ref, authority);
      check(materials.length <= assistantContextLimits.entries);
      let materialBytes = 0;
      const copies = materials.map(({ sourceId, bytes }) => {
        check(
          bytes instanceof Uint8Array &&
            bytes.byteLength <= assistantContextLimits.bytes,
        );
        materialBytes += bytes.byteLength;
        check(materialBytes <= assistantContextLimits.bytes);
        return { sourceId, bytes: new Uint8Array(bytes) };
      });
      validateAssistantMaterials(
        record.instructionSet,
        copies,
        this.authorityScope,
      );
      signal.throwIfAborted();
      const root = await this.prepare(true, signal);
      for (const source of record.instructionSet.sources) {
        if (source.status !== "available") continue;
        const material = copies.find((item) => item.sourceId === source.id)!;
        await this.publish(
          root,
          "objects",
          source.contentHash,
          material.bytes,
          signal,
        );
      }
      // A partial material write never creates an accepted submission.
      signal.throwIfAborted();
      await this.publish(
        root,
        "accepted",
        `${ref.acceptanceId}.json`,
        Buffer.from(encodeAssistantContext(record)),
        signal,
      );
    });
  }

  async readAccepted(
    reference: AcceptedContextRef,
    authority: HostAuthority,
    signal: AbortSignal,
  ): Promise<RetainedAssistantContext> {
    return this.safe(signal, async () => {
      validateAcceptedContextRef(reference);
      const ref = { ...reference };
      this.authorize(ref, authority);
      const root = await this.prepare(false, signal);
      const bytes = await this.read(
        root,
        "accepted",
        `${ref.acceptanceId}.json`,
        signal,
      );
      const accepted: unknown = JSON.parse(bytes.toString("utf8"));
      validateAcceptedAssistantContext(accepted);
      check(
        Buffer.from(encodeAssistantContext(accepted)).equals(bytes) &&
          encodeAssistantContext(referenceOf(accepted)) ===
            encodeAssistantContext(ref),
      );
      const materials: SourceMaterial[] = [];
      for (const source of accepted.instructionSet.sources) {
        if (source.status !== "available") continue;
        const bytes = await this.read(
          root,
          "objects",
          source.contentHash,
          signal,
        );
        check(assistantContentHash(bytes) === source.contentHash);
        materials.push({ sourceId: source.id, bytes });
      }
      const sources = validateAssistantMaterials(
        accepted.instructionSet,
        materials,
        this.authorityScope,
      );
      signal.throwIfAborted();
      return { accepted, sources };
    });
  }

  private authorize(ref: AcceptedContextRef, authority: HostAuthority): void {
    validateAcceptedContextRef(ref);
    check(
      ref.authorityScope === this.authorityScope &&
        authority.authorityScope === this.authorityScope &&
        ref.conversationId === authority.conversationId,
    );
  }

  private async safe<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      signal.throwIfAborted();
      const result = await operation();
      signal.throwIfAborted();
      return result;
    } catch {
      signal.throwIfAborted();
      throw new AssistantContextError();
    }
  }

  private async directory(path: string, privateMode: boolean): Promise<void> {
    const stat = await fs.lstat(path);
    check(stat.isDirectory() && !stat.isSymbolicLink());
    if (privateMode && process.platform !== "win32")
      check((stat.mode & 0o077) === 0);
  }

  private async prepare(create: boolean, signal: AbortSignal): Promise<string> {
    await this.directory(this.stateRoot, false);
    const base = await fs.realpath(this.stateRoot);
    let current = base;
    for (const name of ["assistant-context", "v1", this.authorityScope]) {
      signal.throwIfAborted();
      current = join(current, name);
      if (create) {
        try {
          await fs.mkdir(current, { mode: 0o700 });
        } catch (error) {
          if (!isCode(error, "EEXIST")) throw error;
        }
      }
      await this.directory(current, true);
      if (create) await this.syncDirectory(dirname(current));
    }
    for (const name of ["objects", "accepted"]) {
      if (create) {
        try {
          await fs.mkdir(join(current, name), { mode: 0o700 });
        } catch (error) {
          if (!isCode(error, "EEXIST")) throw error;
        }
      }
      await this.directory(join(current, name), true);
    }
    if (create) await this.syncDirectory(current);
    await this.assertRoot(current);
    return current;
  }

  private async assertRoot(root: string): Promise<void> {
    await this.directory(this.stateRoot, false);
    let current = await fs.realpath(this.stateRoot);
    for (const name of ["assistant-context", "v1", this.authorityScope]) {
      current = join(current, name);
      await this.directory(current, true);
    }
    check(current === root && (await fs.realpath(root)) === root);
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await fs.open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      check((await handle.stat()).isDirectory());
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async read(
    root: string,
    area: "objects" | "accepted",
    key: string,
    signal: AbortSignal,
  ): Promise<Buffer> {
    signal.throwIfAborted();
    await this.assertRoot(root);
    const directory = join(root, area);
    await this.directory(directory, true);
    const handle = await fs.open(
      join(directory, key),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      check(stat.isFile() && stat.size <= assistantContextLimits.bytes);
      if (process.platform !== "win32") check((stat.mode & 0o077) === 0);
      // Bound allocation even if a file grows after stat. An extra byte detects growth.
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        signal.throwIfAborted();
        const read = await handle.read(
          bytes,
          length,
          bytes.length - length,
          null,
        );
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      check(length === stat.size);
      const after = await handle.stat();
      const pathStat = await fs.lstat(join(directory, key));
      check(
        after.size === stat.size &&
          after.mtimeMs === stat.mtimeMs &&
          pathStat.isFile() &&
          pathStat.ino === stat.ino &&
          pathStat.dev === stat.dev,
      );
      await this.assertRoot(root);
      await this.directory(directory, true);
      signal.throwIfAborted();
      return bytes.subarray(0, length);
    } finally {
      await handle.close();
    }
  }

  private async publish(
    root: string,
    area: "objects" | "accepted",
    key: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.assertRoot(root);
    const directory = join(root, area);
    await this.directory(directory, true);
    const temporary = join(directory, `.tmp-${randomUUID()}`);
    const handle = await fs.open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        await handle.writeFile(bytes);
        signal.throwIfAborted();
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.assertRoot(root);
      await this.directory(directory, true);
      signal.throwIfAborted();
      try {
        await fs.link(temporary, join(directory, key));
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
      }
      check((await this.read(root, area, key, signal)).equals(bytes));
      await this.syncDirectory(directory);
      await this.assertRoot(root);
      signal.throwIfAborted();
    } finally {
      // Never clean someone else's material or roll back an immutable publication.
      await fs.unlink(temporary).catch(() => {});
    }
  }
}
