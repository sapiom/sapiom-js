import { createHash } from "node:crypto";

import { ADYEN_CHECKOUT_ORIGINS } from "./detect.js";
import { isRecord } from "./guards.js";

/** The four fields Adyen secured fields encrypt, as the Pay body names them. */
export const ADYEN_ENCRYPTED_FIELDS = [
  "encryptedCardNumber",
  "encryptedExpiryMonth",
  "encryptedExpiryYear",
  "encryptedSecurityCode",
] as const;

export type AdyenEncryptedField = (typeof ADYEN_ENCRYPTED_FIELDS)[number];

/** sha256 hex of each blob the page's secured fields produced for the placeholder. */
export type PlaceholderBlobHashes = Record<AdyenEncryptedField, string>;

export const ADYEN_BLOB_BINDING = "__sapiomAdyenBlob";

/**
 * The isolated world the watch script and its binding live in. Page scripts
 * run in the main world, so they can neither reach the binding nor replace
 * what the script uses; window events still reach listeners in every world.
 */
export const ADYEN_WATCH_WORLD = "sapiom-adyen-watch";

/**
 * Runs in each document's watch world. It listens, and only listens, for
 * the `encryption` messages Adyen's secured-field iframes post to the page:
 * a JSON string `{ action: "encryption", fieldType, numKey,
 * [fieldType]: [{ type, encryptedFieldName, blob }] }` from a checkoutshopper
 * origin (adyen-web 6.x `SecuredField.postMessageListenerFn` and
 * `handleEncryption`). The message is never altered, stopped or sent again.
 *
 * The binding is taken into the closure and removed from the world's global.
 * A second run in the same world finds no binding and does nothing, which
 * keeps install idempotent.
 */
export function adyenBlobWatchScript(): string {
  const config = JSON.stringify({
    binding: ADYEN_BLOB_BINDING,
    origins: ADYEN_CHECKOUT_ORIGINS,
    fields: ADYEN_ENCRYPTED_FIELDS,
  });
  return `(() => {
  // Capture before merchant scripts can replace these intrinsics.
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const isArray = Array.isArray;
  const config = ${config};
  const send = globalThis[config.binding];
  if (typeof send !== "function") return;
  try { delete globalThis[config.binding]; } catch {}
  const isOrigin = Set.prototype.has.bind(new Set(config.origins));
  const isField = Set.prototype.has.bind(new Set(config.fields));
  addEventListener("message", (event) => {
    try {
      if (!event.isTrusted || !isOrigin(event.origin)) return;
      if (typeof event.data !== "string") return;
      const data = parse(event.data);
      if (!data || data.action !== "encryption") return;
      const list = data[data.fieldType];
      if (!isArray(list)) return;
      for (let index = 0; index < list.length; index++) {
        const item = list[index];
        if (!item || !isField(item.encryptedFieldName)) continue;
        if (typeof item.blob !== "string" || item.blob === "") continue;
        // No inherited toJSON hook from the merchant's Object.prototype.
        send(stringify({ __proto__: null, field: item.encryptedFieldName, blob: item.blob }));
      }
    } catch {}
  });
})();`;
}

/**
 * Hashes one binding payload. The raw blob is not kept: only the field name
 * and its sha256 hex leave this function.
 */
export function hashObservedBlob(
  payload: unknown,
): { field: AdyenEncryptedField; hash: string } | undefined {
  if (typeof payload !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const { field, blob } = parsed;
  if (!isEncryptedField(field)) return undefined;
  if (typeof blob !== "string" || blob === "") return undefined;
  return {
    field,
    hash: createHash("sha256").update(blob, "utf8").digest("hex"),
  };
}

function isEncryptedField(value: unknown): value is AdyenEncryptedField {
  return (ADYEN_ENCRYPTED_FIELDS as readonly unknown[]).includes(value);
}

/** All four hashes, or the names of the fields never observed. */
export function placeholderBlobHashes(
  seen: ReadonlyMap<AdyenEncryptedField, string>,
): { hashes: PlaceholderBlobHashes } | { missing: AdyenEncryptedField[] } {
  const missing = ADYEN_ENCRYPTED_FIELDS.filter((field) => !seen.has(field));
  if (missing.length > 0) return { missing };
  return {
    hashes: {
      encryptedCardNumber: seen.get("encryptedCardNumber")!,
      encryptedExpiryMonth: seen.get("encryptedExpiryMonth")!,
      encryptedExpiryYear: seen.get("encryptedExpiryYear")!,
      encryptedSecurityCode: seen.get("encryptedSecurityCode")!,
    },
  };
}
