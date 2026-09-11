/**
 * emitEvent — announce that something happened in the tenant, and let whatever
 * subscribes to it start.
 *
 * Networked operation: takes a GatewayClient. The route is `POST /events`
 * relative to the `/v1/workflows` base the client already targets.
 *
 * This is the START verb, and it is the other half of `signal.ts`: an event
 * fans out by `type` to every active `event` trigger the tenant armed and
 * starts 0..N NEW runs, while a signal wakes runs that are already paused.
 * Events start, signals resume — one namespace each, and neither reaches the
 * other's.
 *
 * A thin passthrough, like `schedule.ts`. Two deliberate non-features:
 *
 * - **No client-side validation of `type`.** The grammar (lowercase
 *   dot-separated segments, `sapiom.*` reserved) is the engine's, and its 400
 *   relays verbatim through the tenant API. Restating it here would give the
 *   same input two answers that can drift; the one that is always right is the
 *   server's.
 * - **The result is the server's DTO, verbatim.** `signal()` defaults its
 *   `matched` because the body is not guaranteed to carry it; here every field
 *   is, and a receipt id this function invented would be a lie a caller could
 *   go on to read back (`GET /v1/workflows/receipts/:id`).
 */
import { GatewayClient } from "./client.js";
import { AgentOperationError } from "./errors.js";

export interface EmitEventOptions {
  /**
   * What happened, as the triggers are matched on it: lowercase `[a-z0-9_]`
   * segments joined by dots (`lead.created`). The `sapiom.*` namespace is
   * reserved and 400s. Enforced by the engine, not here.
   */
  type: string;
  /**
   * Event data. Must be a top-level JSON object: it becomes the top layer of
   * the run-input fold, folded over each matched trigger's configured `input`
   * (the payload wins on a key conflict). An array or a scalar is a 400 — the
   * server gates the shape precisely because the fold would otherwise treat a
   * non-object as absent and start a run with the data dropped. `emitEvent`
   * checks the same rule locally so a JS caller gets the answer without the
   * round-trip.
   */
  payload: Record<string, unknown>;
  /**
   * The sender's id for THIS delivery, 1..256 chars — the dedup identity.
   * Reposting the same id returns the original receipt and starts nothing new,
   * which is what makes a retry safe. Omit it and the server mints a UUID, so
   * the call is accepted but a retry is a SECOND event. Sent on the wire as
   * `id`; named `eventId` here because `id` alone, on an options object next to
   * `type` and `payload`, reads as the event's own identity rather than the
   * sender's.
   */
  eventId?: string;
}

/**
 * `matched` — at least one active trigger subscribed to the type and was
 * fired. `unmatched` — none did. The event is still recorded either way.
 */
export type EventOutcome = "matched" | "unmatched";

export interface EmitEventResult {
  /** The ledger row this delivery became. Read the chain back with `GET /v1/workflows/receipts/:id`. */
  receiptId: string;
  /**
   * `unmatched` is NOT an error and never throws: it means no active `event`
   * trigger subscribes to this type — a typo in `type`, or nothing armed yet.
   */
  outcome: EventOutcome;
  /**
   * True when this delivery collided with an earlier one carrying the same
   * `eventId`. The receipt above is the ORIGINAL, nothing new was started, and
   * `fireIds` is empty — a retry loop sees success rather than a conflict.
   */
  duplicate: boolean;
  /**
   * One id per trigger fire this event created — fire ids, not execution ids.
   * Empty on `unmatched` and on a duplicate. To get from a fire to the run it
   * started, read the receipt.
   */
  fireIds: string[];
}

/**
 * Emit one custom event for this tenant. Returns as soon as the receipt is
 * committed; the runs it started are enqueued, so an empty `fireIds` means
 * "nothing was fired", never "nothing has finished yet".
 *
 * Throws `AgentOperationError` on gateway errors — including the engine's
 * validation 400s (reserved or malformed `type`, an over-long `eventId`) and
 * the per-IP throttle's 429.
 */
export async function emitEvent(
  opts: EmitEventOptions,
  client: GatewayClient,
): Promise<EmitEventResult> {
  // Re-checked here, not just in the parse helpers: `EmitEventOptions` binds
  // TypeScript callers, but this is a published package and a JS caller reaches
  // the same function with no type to stop them. The server does reject a
  // non-object payload, so nothing is lost either way — this just turns a
  // round-trip and an opaque HTTP_400 into the same BAD_PAYLOAD the CLI and the
  // MCP already raise.
  const payload = asEventPayload(opts.payload);
  // The one check that CANNOT be left to the server, and the reason this
  // otherwise-passthrough function validates at all. `JSON.parse('{"a":1e400}')`
  // yields `Infinity` with no error; the `JSON.stringify` on the way out has no
  // representation for it and emits `null`. So by the time the request arrives,
  // the number is already a null and the server's own non-finite rejection sees
  // nothing wrong — the receipt would record a null the sender never wrote.
  // Every other rule stays the engine's; this one has to run before the
  // serialization that destroys the evidence.
  const unserializable = findUnserializable(payload);
  if (unserializable) {
    throw new AgentOperationError({
      code: "BAD_PAYLOAD",
      message: `\`${unserializable.path}\` ${unserializable.reason}`,
    });
  }
  return client.post<EmitEventResult>("/events", {
    type: opts.type,
    payload,
    // Omit rather than send `id: undefined`: the route runs a whitelisting
    // validation pipe, so a declared-but-empty field is not the same as an
    // absent one, and absent is what "let the server mint a UUID" means.
    ...(opts.eventId !== undefined ? { id: opts.eventId } : {}),
  });
}

/**
 * The first value in the payload that `JSON.stringify` cannot carry honestly,
 * with the path to it, or `null` when the payload survives the round trip.
 *
 * Three cases, and only three — each one where the caller would otherwise be
 * told something untrue:
 *
 * - A **non-finite number** (`Infinity`, `NaN`) serializes to `null`, so the
 *   receipt records a value the sender never wrote.
 * - A **BigInt** makes `JSON.stringify` throw from inside the client's fetch
 *   try-block, which reports it as `NETWORK` — "could not reach the host" for
 *   what is entirely a payload problem.
 * - A **cycle** does the same, and the walk below would otherwise recurse into
 *   it until the stack gives out.
 *
 * Deliberately NOT rejected, though `JSON.stringify` transforms them too:
 * `undefined`, functions and symbols (dropped — JSON has no encoding for them,
 * every other verb in this SDK behaves identically, and an absent key is
 * indistinguishable from one never set), and an array hole, which serializes to
 * `null` by the same documented mapping.
 *
 * Anything defining `toJSON` is left to the serializer entirely — see the
 * comment at that branch. So the reach of this check stops at code it does not
 * run, which is the boundary that keeps it side-effect free.
 *
 * An explicit walk rather than a `JSON.stringify` replacer, even though a
 * replacer would visit the same values: a replacer is handed the immediate key
 * and nothing else, so the most it could say about `{ a: { b: Infinity } }` is
 * `b` — a field the sender cannot locate. The path is the whole value of the
 * message. And inspecting the serialized OUTPUT instead is no help at all: by
 * then `Infinity` is already the `null` this check exists to catch.
 */
function findUnserializable(
  value: unknown,
  at = "payload",
  seen = new WeakSet<object>(),
): { path: string; reason: string } | null {
  if (typeof value === "number" && !Number.isFinite(value)) {
    return {
      path: at,
      reason:
        "is not a finite number; JSON cannot carry it and it would be recorded as null.",
    };
  }
  if (typeof value === "bigint") {
    return {
      path: at,
      reason:
        "is a BigInt; JSON cannot carry it. Send it as a string or a number.",
    };
  }
  if (typeof value !== "object" || value === null) return null;

  // A value that defines `toJSON` is OPAQUE here: not called, not descended
  // into. The serializer owns it.
  //
  // Calling it was worse in three ways at once, and one line could not fix all
  // three. A validation pass must not invoke caller code: the side effects then
  // happen twice (once here, once in `JSON.stringify`), a `toJSON` that is not
  // a pure projection sends data this function never saw, and getting it right
  // means reproducing the serializer's calling convention exactly — it passes
  // the property key, and a `toJSON(key)` that uses that key threw here while
  // serializing perfectly well. Not calling it removes all three.
  //
  // The cost is the narrow, deliberate gap documented above: a non-finite
  // number or a BigInt that a custom `toJSON` *produces* is not caught locally
  // and degrades to what every other verb in this SDK already does with it.
  // The object's own author controls that, and this check never claimed reach
  // into code it does not run.
  const resolved: object = value;
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return null;

  // The guard that keeps a self-referential payload from exhausting the stack.
  // Checked before descending, so the cycle is reported at the edge that closes
  // it rather than wherever the recursion happened to give out.
  if (seen.has(resolved)) {
    return {
      path: at,
      reason: "is a circular reference; JSON cannot carry it.",
    };
  }
  seen.add(resolved);

  // Indexed rather than `.map`/`Object.entries` on an array: `.map` preserves
  // holes, so a sparse array (`new Array(1)`, `[1, , 3]`) yielded an `undefined`
  // slot that destructuring then choked on. `JSON.stringify` writes a hole as
  // `null` and moves on, so the walk has to reach every index and accept them.
  if (Array.isArray(resolved)) {
    for (let index = 0; index < resolved.length; index += 1) {
      const found = findUnserializable(
        resolved[index],
        `${at}[${index}]`,
        seen,
      );
      if (found) return found;
    }
  } else {
    for (const [key, entry] of Object.entries(resolved)) {
      const found = findUnserializable(entry, `${at}.${key}`, seen);
      if (found) return found;
    }
  }
  // Dropped once its subtree is cleared: a value repeated across sibling
  // branches (the same object under two keys) is fine — JSON writes it twice.
  // Only an ancestor repeating itself is a cycle.
  seen.delete(resolved);
  return null;
}

/**
 * Narrow an already-decoded value to an event payload. One rule in one place:
 * `emitEvent`, `parseEventPayload` and the MCP tool all land here, so a JS
 * caller, a `--payload` string and a tool argument get the same answer.
 *
 * The rule is not arbitrary. An array or a scalar is valid JSON, and the
 * run-input fold treats a non-object as ABSENT — a run would start with its
 * data dropped. The server gates the shape for exactly that reason and 400s;
 * this check just moves the same verdict to the call site, before the wire.
 *
 * Separate from `parseEventPayload` because a caller may already hold a value
 * rather than a string — an MCP tool argument, for instance — and re-encoding
 * it just to re-parse it would only add a way to fail.
 */
export function asEventPayload(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentOperationError({
      code: "BAD_PAYLOAD",
      message:
        "Event payload must be a JSON object (it becomes the top layer of the run input).",
    });
  }
  return value as Record<string, unknown>;
}

/**
 * Parse a JSON payload string for an event. Exported so callers (CLI, MCP) can
 * normalize errors consistently — the sibling of `parseSignalPayload`, but
 * stricter: a signal's payload is opaque to the SDK, an event's has to survive
 * the run-input fold, and a valid-JSON array would be accepted here only to be
 * rejected a network round-trip later.
 */
export function parseEventPayload(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AgentOperationError({
      code: "BAD_PAYLOAD",
      message: "Event payload is not valid JSON.",
    });
  }
  return asEventPayload(value);
}
