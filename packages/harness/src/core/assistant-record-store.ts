import { join } from "node:path";
import type {
  AssistantRecord,
  AssistantRecordBinding,
} from "../shared/assistant-record.js";
import {
  AssistantRecordError,
  projectAssistantRecord,
  validateAssistantRecord,
  validateAssistantRecordBinding,
} from "./assistant-record.js";
import {
  assistantDirectory,
  readAssistantJson,
  writeAssistantJson,
} from "./assistant-session-files.js";
import { DurableFileLock } from "./durable-file-lock.js";

/** External checkpoints survive native-root deletion. No source or pinned-record GC. */
export class AssistantRecordStore {
  constructor(private readonly stateRoot: string) {}

  /** Reserve before native IO, so a retired runtime's late snapshot has an older revision. */
  async reserve(binding: AssistantRecordBinding): Promise<number> {
    binding = validateAssistantRecordBinding(binding);
    const directory = await this.directory(binding);
    const unlock = await new DurableFileLock(
      join(directory, "record.json"),
    ).acquire();
    try {
      const counter = await readAssistantJson(
        join(directory, "capture-revision.json"),
      );
      if (
        counter !== null &&
        (!Number.isSafeInteger(counter) || (counter as number) < 1)
      )
        throw new AssistantRecordError("corrupt_record");
      const previous = await this.read(binding);
      const revision =
        Math.max((counter as number | null) ?? 0, previous?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision))
        throw new AssistantRecordError("record_unavailable");
      await writeAssistantJson(directory, "capture-revision.json", revision);
      return revision;
    } finally {
      await unlock();
    }
  }

  async read(binding: AssistantRecordBinding): Promise<AssistantRecord | null> {
    binding = validateAssistantRecordBinding(binding);
    try {
      const directory = await this.directory(binding);
      const value = await readAssistantJson(join(directory, "record.json"));
      return value === null ? null : validateAssistantRecord(value, binding);
    } catch (error) {
      if (error instanceof AssistantRecordError) throw error;
      throw new AssistantRecordError("record_unavailable");
    }
  }

  /** Revisions belong to capture scheduling; a late native response cannot win. */
  async write(value: AssistantRecord): Promise<boolean> {
    // Validate and detach caller-owned objects before waiting for the lock.
    const record = validateAssistantRecord(JSON.parse(JSON.stringify(value)));
    try {
      const directory = await this.directory(record.binding);
      const file = join(directory, "record.json");
      const unlock = await new DurableFileLock(file).acquire();
      try {
        const saved = await readAssistantJson(file);
        const previous =
          saved === null
            ? null
            : validateAssistantRecord(saved, record.binding);
        if (
          previous !== null &&
          (previous.revision >= record.revision ||
            (previous.messageCount > 0 && record.messageCount === 0))
        )
          return false;
        await writeAssistantJson(directory, "record.json", record);
        return true;
      } finally {
        await unlock();
      }
    } catch (error) {
      if (error instanceof AssistantRecordError) throw error;
      throw new AssistantRecordError("record_unavailable");
    }
  }

  async capture(
    nativeMessages: unknown,
    binding: AssistantRecordBinding,
    revision: number,
    capturedAt?: string,
  ): Promise<AssistantRecord> {
    const record = projectAssistantRecord(
      nativeMessages,
      binding,
      revision,
      capturedAt,
    );
    if (await this.write(record)) return record;
    const latest = await this.read(record.binding);
    if (latest === null) throw new AssistantRecordError("record_unavailable");
    return latest;
  }

  private directory(binding: AssistantRecordBinding): Promise<string> {
    return assistantDirectory(
      this.stateRoot,
      binding.harnessSessionId,
      binding.contextAuthorityScope,
    );
  }
}
