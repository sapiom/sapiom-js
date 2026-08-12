import { SearchIndexHttpError } from "./errors.js";
import type {
  CreateSearchIndexInput,
  DataPlaneOptions,
  SearchDocumentInput,
  SearchIndexIncludeOptions,
  SearchIndexRangeInput,
  SearchQueryInput,
  UpdateSearchIndexInput,
} from "./index.js";

export const DEFAULT_SEARCH_INDEX_RANGE_CURSOR = "0";
export const DEFAULT_SEARCH_INDEX_RANGE_LIMIT = 100;
export const DEFAULT_SEARCH_INDEX_QUERY_LIMIT = 5;

const INDEX_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const CURSOR_PATTERN = /^\d+$/;
const TTL_PATTERN = /^(\d+)([mhd])$/;
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const MAX_TTL_MS = 30 * 86_400_000;
const MAX_RESULT_LIMIT = 1_000;

function invalid(message: string, body?: unknown): never {
  throw new SearchIndexHttpError(message, 400, body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateBoundedLimit(
  value: unknown,
  field: string,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_RESULT_LIMIT
  ) {
    invalid(`${field} must be an integer from 1 to ${MAX_RESULT_LIMIT}`, {
      [field]: value,
    });
  }
}

export function validateCreateSearchIndexInput(
  input: CreateSearchIndexInput,
): void {
  if (!isRecord(input)) invalid("create requires an input object", { input });
  if (
    typeof input.name !== "string" ||
    input.name.length < 1 ||
    input.name.length > 128
  ) {
    invalid("create requires a name of 1-128 characters", { name: input.name });
  }
  if (
    input.region !== undefined &&
    (typeof input.region !== "string" ||
      input.region.length < 1 ||
      input.region.length > 64)
  ) {
    invalid("region must be a non-empty string of at most 64 characters", {
      region: input.region,
    });
  }
  if (input.ttl !== undefined) {
    if (typeof input.ttl !== "string") {
      invalid('ttl must use the form "30m", "24h", or "7d"', {
        ttl: input.ttl,
      });
    }
    const match = TTL_PATTERN.exec(input.ttl);
    if (!match) {
      invalid('ttl must use the form "30m", "24h", or "7d"', {
        ttl: input.ttl,
      });
    }
    const amount = Number(match[1]);
    const multiplier = { m: 60_000, h: 3_600_000, d: 86_400_000 }[
      match[2] as "m" | "h" | "d"
    ];
    if (amount < 1 || amount * multiplier > MAX_TTL_MS) {
      invalid("ttl must be greater than zero and no more than 30 days", {
        ttl: input.ttl,
      });
    }
  }
}

export function validateUpdateSearchIndexInput(
  input: UpdateSearchIndexInput,
): void {
  if (!isRecord(input)) invalid("update requires an input object", { input });
  if (
    input.name !== undefined &&
    (typeof input.name !== "string" ||
      input.name.length < 1 ||
      input.name.length > 128)
  ) {
    invalid("name must contain 1-128 characters", { name: input.name });
  }
  if (input.expiresAt !== undefined) {
    if (
      typeof input.expiresAt !== "string" ||
      !ISO_DATE_PATTERN.test(input.expiresAt) ||
      !Number.isFinite(Date.parse(input.expiresAt))
    ) {
      invalid("expiresAt must be a valid ISO-8601 date string", {
        expiresAt: input.expiresAt,
      });
    }
    if (Date.parse(input.expiresAt) <= Date.now()) {
      invalid("expiresAt must be in the future", {
        expiresAt: input.expiresAt,
      });
    }
  }
}

export function validateSearchIndexId(id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    invalid("search index id must be a non-empty string", { id });
  }
}

export function resolveSearchIndexName(opts?: DataPlaneOptions): string {
  if (opts !== undefined && !isRecord(opts)) {
    invalid("data-plane options must be an object", { opts });
  }
  const indexName = opts?.indexName ?? "default";
  if (typeof indexName !== "string" || !INDEX_NAME_PATTERN.test(indexName)) {
    invalid(
      `indexName must match ${INDEX_NAME_PATTERN} (got "${String(indexName)}")`,
      {
        indexName,
      },
    );
  }
  return indexName;
}

export function validateSearchDocumentInputs(
  documents: SearchDocumentInput[],
): void {
  if (!Array.isArray(documents) || documents.length === 0) {
    invalid("upsert requires at least one document", { documents });
  }
  documents.forEach((document, index) => {
    if (!isRecord(document)) {
      invalid(`document at index ${index} must be an object`, { document });
    }
    if (typeof document.id !== "string" || document.id.length === 0) {
      invalid(`document at index ${index} requires a non-empty id`, {
        id: document.id,
      });
    }
    if (!isRecord(document.content)) {
      invalid(`document '${document.id}' content must be an object`, {
        content: document.content,
      });
    }
    if (document.metadata !== undefined && !isRecord(document.metadata)) {
      invalid(
        `document '${document.id}' metadata must be an object when provided`,
        {
          metadata: document.metadata,
        },
      );
    }
  });
}

export function validateSearchQueryInput(input: SearchQueryInput): void {
  if (!isRecord(input)) invalid("query requires an input object", { input });
  if (typeof input.query !== "string" || input.query.trim().length === 0) {
    invalid("query requires a non-empty query string", { query: input.query });
  }
  if (input.limit !== undefined) validateBoundedLimit(input.limit, "limit");
  if (input.reranking !== undefined && typeof input.reranking !== "boolean") {
    invalid("reranking must be a boolean", { reranking: input.reranking });
  }
  if (input.filter !== undefined && typeof input.filter !== "string") {
    invalid("filter must be a string", { filter: input.filter });
  }
}

export function validateSearchIndexIncludeOptions(
  opts: SearchIndexIncludeOptions | undefined,
): void {
  if (
    opts?.includeMetadata !== undefined &&
    typeof opts.includeMetadata !== "boolean"
  ) {
    invalid("includeMetadata must be a boolean", {
      includeMetadata: opts.includeMetadata,
    });
  }
  if (
    opts?.includeData !== undefined &&
    typeof opts.includeData !== "boolean"
  ) {
    invalid("includeData must be a boolean", { includeData: opts.includeData });
  }
}

export function normalizeSearchIndexRangeInput(
  input?: SearchIndexRangeInput,
): Required<Pick<SearchIndexRangeInput, "cursor" | "limit">> &
  SearchIndexIncludeOptions {
  if (input !== undefined && !isRecord(input)) {
    invalid("range input must be an object", { input });
  }
  const cursor = input?.cursor ?? DEFAULT_SEARCH_INDEX_RANGE_CURSOR;
  const limit = input?.limit ?? DEFAULT_SEARCH_INDEX_RANGE_LIMIT;
  if (typeof cursor !== "string" || !CURSOR_PATTERN.test(cursor)) {
    invalid('cursor must be a numeric string (use "0" for the first page)', {
      cursor,
    });
  }
  validateBoundedLimit(limit, "limit");
  validateSearchIndexIncludeOptions(input);
  return {
    cursor,
    limit,
    ...(typeof input?.includeMetadata === "boolean" && {
      includeMetadata: input.includeMetadata,
    }),
    ...(typeof input?.includeData === "boolean" && {
      includeData: input.includeData,
    }),
  };
}

export function validateSearchDocumentIds(
  ids: string[],
  operation: string,
): void {
  if (!Array.isArray(ids) || ids.length === 0) {
    invalid(`${operation} requires at least one id`, { ids });
  }
  ids.forEach((id, index) => {
    if (typeof id !== "string" || id.length === 0) {
      invalid(`${operation} id at index ${index} must be a non-empty string`, {
        id,
      });
    }
  });
}
