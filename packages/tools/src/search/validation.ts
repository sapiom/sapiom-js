import { SearchHttpError } from "./errors.js";

/** Validate `search.map` input identically on the live and local-stub surfaces. */
export function validateMapInput(
  input: unknown,
): asserts input is { url: string } {
  const isObject =
    input !== null && typeof input === "object" && !Array.isArray(input);
  const url = isObject ? (input as Record<string, unknown>).url : undefined;
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new SearchHttpError("map requires a non-empty url", 400, { url });
  }
}
