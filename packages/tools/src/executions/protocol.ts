import { ExecutionProtocolError, executionFailureStatus } from "./errors.js";
import type {
  ExecutionReceipt,
  ExecutionReference,
  ExecutionState,
} from "./types.js";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);
const validDate = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const statuses = ["queued", "running", "succeeded", "failed", "indeterminate"];

export function validateId(id: string): void {
  if (
    typeof id !== "string" ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)
  )
    throw new ExecutionProtocolError("Invalid execution ID.");
}
export function validateKey(key: string): void {
  if (typeof key !== "string" || !/^[\x21-\x7e]{1,200}$/.test(key))
    throw new ExecutionProtocolError(
      "Submission key must contain 1–200 printable non-space ASCII characters.",
    );
}
export function validateCapability(id: string): void {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id))
    throw new ExecutionProtocolError("Invalid capability ID.");
}
export function normalizeBaseUrl(base: string): string {
  try {
    const url = new URL(base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.includes("?") ||
      url.href.includes("#")
    )
      throw new Error();
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new ExecutionProtocolError(
      "Core base URL must be HTTP(S) without credentials, query or fragment.",
    );
  }
}

/** Unknown additive fields (including URLs) are ignored, never used as destinations. */
export function parseExecution<T>(
  value: unknown,
  outcome: boolean,
  reference: ExecutionReference = {},
  capabilityId?: string,
): ExecutionReceipt | ExecutionState<T> {
  const bad = () =>
    new ExecutionProtocolError(
      "Invalid or unsupported execution response.",
      reference,
    );
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    typeof value.capabilityId !== "string" ||
    typeof value.status !== "string" ||
    !statuses.includes(value.status) ||
    !validDate(value.createdAt) ||
    !validDate(value.expiresAt) ||
    Date.parse(value.expiresAt as string) <
      Date.parse(value.createdAt as string)
  )
    throw bad();
  try {
    validateId(value.id);
    validateCapability(value.capabilityId);
  } catch {
    throw bad();
  }
  if (
    (reference.executionId &&
      value.id.toLowerCase() !== reference.executionId.toLowerCase()) ||
    (capabilityId && value.capabilityId !== capabilityId)
  )
    throw bad();
  const receipt: ExecutionReceipt = {
    version: 1,
    id: value.id.toLowerCase(),
    capabilityId: value.capabilityId,
    status: value.status as ExecutionReceipt["status"],
    createdAt: value.createdAt as string,
    expiresAt: value.expiresAt as string,
  };
  if (!outcome || receipt.status === "queued" || receipt.status === "running") {
    if (own(value, "result") || own(value, "error")) throw bad();
    return receipt;
  }
  if (receipt.status === "succeeded") {
    if (!own(value, "result") || own(value, "error")) throw bad();
    return { ...receipt, status: "succeeded", result: value.result as T };
  }
  const error = value.error;
  if (
    own(value, "result") ||
    !isRecord(error) ||
    typeof error.code !== "string" ||
    !own(executionFailureStatus, error.code) ||
    typeof error.message !== "string" ||
    !error.message ||
    error.message.length > 2000 ||
    (receipt.status === "indeterminate") !==
      (error.code === "execution_indeterminate")
  )
    throw bad();
  return {
    ...receipt,
    status: receipt.status,
    error: {
      code: error.code as keyof typeof executionFailureStatus,
      message: error.message,
    },
  };
}
