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
   *
   * **Extra keys reach the run; what happens to them is the entry schema's
   * call.** The engine can drop payload keys an agent's entry step did not
   * declare, but only when the STORED manifest literally closes the object
   * (`additionalProperties: false`). Agents built with `@sapiom/agent` do not
   * hit that path: `buildManifest` strips that marker at every depth, by
   * design and even for `z.strictObject()`, so the stored schema stays
   * forward-compatible with inputs that gain fields. So for an SDK-authored
   * agent the extra key is NOT dropped — it arrives in the run input, and the
   * author's own Zod parse at the step decides: `z.object()` ignores it,
   * `z.strictObject()` REJECTS it and the step fails.
   *
   * Practical reading: sending keys the entry step does not declare is safe
   * against a loose schema and fails the run against a strict one. Neither
   * shows up here — the emit succeeds either way.
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
  // The walk reports findings by returning them, so anything THROWN out of it
  // is the walk itself failing, not the payload being bad — a value nested
  // deeper than the call stack is the realistic one, and it arrived as a raw
  // `RangeError` that no caller's `AgentOperationError` handling catches.
  // Best-effort by contract: when the check cannot complete, it stops and the
  // serializer decides. A validation pass must never be the reason an emit
  // fails, which is the same rule every other give-up path here follows.
  let unserializable: Unserializable | null = null;
  try {
    unserializable = findUnserializable(payload);
  } catch {
    unserializable = null;
  }
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
 * Anything whose value is produced by CALLER CODE is left to the serializer
 * entirely — a `toJSON`, and a getter (see those two branches). The reach of
 * this check stops at code it does not run: that is what keeps the pass free of
 * side effects, and what makes "validated" and "sent" the same bytes rather
 * than two separate reads that can disagree.
 *
 * An explicit walk rather than a `JSON.stringify` replacer, even though a
 * replacer would visit the same values: a replacer is handed the immediate key
 * and nothing else, so the most it could say about `{ a: { b: Infinity } }` is
 * `b` — a field the sender cannot locate. The path is the whole value of the
 * message. And inspecting the serialized OUTPUT instead is no help at all: by
 * then `Infinity` is already the `null` this check exists to catch.
 */
/** A value the serializer cannot carry honestly, and where it sits. */
interface Unserializable {
  path: string;
  reason: string;
}

function findUnserializable(
  value: unknown,
  at = "payload",
  seen = new WeakSet<object>(),
): Unserializable | null {
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
  // Probed by descriptor, not by reading `value.toJSON`: that read is itself a
  // property access, and an object whose `toJSON` is a GETTER would run it here
  // and again inside `JSON.stringify`. A getter answering `undefined` first and
  // a function second had this walk validate the raw object and the serializer
  // send the projection — `10` validated, `20` sent, and the `Infinity` variant
  // past the check as `null`. Same rule as everywhere else in this walk: if
  // deciding requires running caller code, don't decide — leave it whole.
  const resolved: object = value;
  if (hasSerializerHook(value)) return null;

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

  const isArray = Array.isArray(resolved);
  if (isArray) {
    const oversize = arrayCannotFit(resolved, at);
    if (oversize) return oversize;
  }

  // Enumerating is caller code once a Proxy is involved (the ownKeys trap), so
  // this fails opaque like the rest: a throw means stop inspecting, not reject.
  const keys = isArray ? arrayIndexKeys(resolved) : ownEnumerableKeys(resolved);
  if (keys === UNREADABLE) {
    seen.delete(resolved);
    return null;
  }
  for (const key of keys) {
    // An array reads each slot the way a property lookup does, so an index the
    // prototype supplies is a real value on the wire; a plain object serializes
    // only its OWN properties, and following its chain would inspect values
    // that never ship.
    const entry = readDataProperty(resolved, key, isArray);
    if (entry.accessor) continue;
    const step = isArray ? `[${key}]` : `.${key}`;
    const found = findUnserializable(entry.value, `${at}${step}`, seen);
    if (found) return found;
  }
  // Dropped once its subtree is cleared: a value repeated across sibling
  // branches (the same object under two keys) is fine — JSON writes it twice.
  // Only an ancestor repeating itself is a cycle.
  seen.delete(resolved);
  return null;
}

/**
 * The route caps an event body at 256 kb. Restated here by value the way the
 * API restates the engine's own limits across its proxy boundary, and used for
 * ONE narrow purpose: see {@link arrayCannotFit}.
 */
const MAX_EVENT_BODY_BYTES = 256 * 1024;

/**
 * An array too long to fit in the body no matter what it holds.
 *
 * Not an attempt to enforce the size limit — the server owns that, and answers
 * 413. This exists because for a sparse array that answer is UNREACHABLE: the
 * serializer writes `null` for every hole up to `length`, so an array holding
 * nothing at all still becomes megabytes of `null,null,…`. A length of 50
 * million measured 250 MB and a quarter of a billion characters here; beyond
 * that the process dies before `fetch` is ever called, and a dead process
 * cannot receive a 413. Same shape as the non-finite check: the only reason to
 * do it locally is that the server's answer cannot arrive.
 *
 * The bound is a floor, never a guess. Each element costs at least one
 * character, plus a separating comma, plus the two brackets — so `2n + 1` is
 * the smallest any array of that length can serialize to. Only lengths whose
 * FLOOR already exceeds the cap are rejected, which means nothing the server
 * would have accepted is refused here; everything borderline still goes and
 * still gets the server's own verdict.
 *
 * `length` is read twice ON PURPOSE, and the direction is the opposite of the
 * double reads removed elsewhere in this file. Those were removed because a
 * value read twice could DIVERGE and the second reading is what shipped. This
 * one exists to detect that divergence and then decline: a `Proxy` around an
 * array is still an array to `Array.isArray`, and its get trap can answer
 * 200000 now and 0 to the serializer, which would refuse a payload that goes
 * out as `[]`. Rejecting is the one verdict this walk never reaches through
 * caller code, so an unstable length simply is not judged. A trap that lies
 * CONSISTENTLY is another matter: the serializer is told the same thing, so
 * the rejection is right.
 */
function arrayCannotFit(value: object, at: string): Unserializable | null {
  let length: number;
  let confirm: number;
  try {
    length = (value as unknown[]).length;
    confirm = (value as unknown[]).length;
  } catch {
    return null;
  }
  if (typeof length !== "number" || length !== confirm) return null;
  if (2 * length + 1 <= MAX_EVENT_BODY_BYTES) return null;
  return {
    path: at,
    reason: `declares a length of ${length}; JSON writes every slot up to it, so this cannot fit the ${MAX_EVENT_BODY_BYTES / 1024} kb event body however few elements it holds.`,
  };
}

/**
 * Sentinel for "the shape could not be established without running something".
 * Every probe that touches caller code returns it, and every caller treats it
 * the same way: stop inspecting, let the serializer decide.
 */
const UNREADABLE = Symbol("unreadable");

/** The own enumerable keys — exactly what `JSON.stringify` writes for a plain object. */
function ownEnumerableKeys(value: object): string[] | typeof UNREADABLE {
  try {
    return Object.keys(value);
  } catch {
    return UNREADABLE;
  }
}

/**
 * The index keys whose values `JSON.stringify` will actually write for an array.
 *
 * Three things make this more than `Object.keys`:
 *
 * - **Enumerability is irrelevant.** JSON writes every slot up to `length`, so
 *   a non-enumerable index counts.
 * - **So is ownership.** A slot is read like any property lookup, so an index
 *   the PROTOTYPE supplies is a real value on the wire — a hole over a
 *   prototype that defines that index serializes the inherited value, not
 *   `null`. Own names alone missed those.
 * - **`length` is the wrong bound to iterate.** A sparse array can declare a
 *   length of 100 million while holding nothing; walking `0..length` allocated
 *   gigabytes to validate a payload that serializes to almost nothing. Reading
 *   the names each object in the chain actually defines keeps this bounded by
 *   content. The gaps left over are holes, and a hole serializes to `null`.
 */
function arrayIndexKeys(value: object): string[] | typeof UNREADABLE {
  let length: number;
  try {
    length = (value as unknown[]).length;
  } catch {
    return UNREADABLE;
  }

  const keys = new Set<string>();
  const visited = new WeakSet<object>();
  let node: object | null = value;
  while (node !== null) {
    if (visited.has(node)) return UNREADABLE;
    visited.add(node);
    let names: string[];
    try {
      names = Object.getOwnPropertyNames(node);
    } catch {
      return UNREADABLE;
    }
    for (const name of names) {
      // Drops `length` and any non-index key (`arr.note = …`), which the
      // serializer ignores — flagging one would reject a payload over a value
      // that never reaches the wire. Past `length` is equally unwritten.
      if (isArrayIndex(name) && Number(name) < length) keys.add(name);
    }
    try {
      node = Object.getPrototypeOf(node) as object | null;
    } catch {
      return UNREADABLE;
    }
  }
  return [...keys];
}

/**
 * A canonical array index, the only own keys `JSON.stringify` writes for an
 * array. The upper bound is load-bearing, not decoration: an array index stops
 * at 2^32 - 2, so `arr[4294967295] = x` is stored as an ordinary property that
 * leaves `length` at 0 and is dropped by the serializer. Without the bound this
 * walk would follow it and could reject a payload over a value that never ships.
 */
const MAX_ARRAY_LENGTH = 4_294_967_295;

function isArrayIndex(key: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < MAX_ARRAY_LENGTH;
}

/**
 * Whether `JSON.stringify` will hand this value's serialization to a `toJSON`,
 * decided WITHOUT reading the property.
 *
 * The descriptor is looked up along the prototype chain because that is where
 * the real ones live — `Date.prototype.toJSON` is a method on the prototype,
 * not an own property, and missing it would send the walk descending into a
 * `Date` it has no business inspecting.
 *
 * A GETTER counts as a hook even though we cannot see what it returns: treating
 * the object as opaque costs only the narrow check this walk already declines
 * to make on `toJSON` output, while reading the getter to find out would
 * reintroduce the double read this exists to stop. A SETTER-ONLY accessor is
 * the opposite — reading it yields `undefined`, so it cannot be a hook, and it
 * shadows anything further up the chain. Calling it one would have made the
 * whole object opaque while `JSON.stringify` walked into it normally.
 *
 * Reflection on a `Proxy` runs its traps, which is caller code this function
 * has no more business running than a getter. Both probes are therefore
 * guarded, and both fail OPAQUE: when the shape cannot be established without
 * running something, stop inspecting and let the serializer decide. The same
 * guard bounds the chain — a proxy can report itself from `getPrototypeOf`, and
 * an unbounded walk over that spins forever, blocking the thread outright
 * rather than answering.
 */
function hasSerializerHook(value: object): boolean {
  const visited = new WeakSet<object>();
  let node: object | null = value;
  while (node !== null) {
    if (visited.has(node)) return true;
    visited.add(node);

    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(node, "toJSON");
    } catch {
      return true;
    }
    if (descriptor) {
      if (descriptor.get) return true;
      if (descriptor.set) return false;
      return typeof descriptor.value === "function";
    }

    try {
      node = Object.getPrototypeOf(node) as object | null;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * One own property, but only when reading it runs no caller code.
 *
 * A getter is skipped rather than invoked, for the reason `toJSON` is: this is
 * a validation pass, and `JSON.stringify` is going to read the property again
 * on its way out. Invoking it here made that two reads, so a getter that does
 * not return the same thing twice sent a value this function never saw — it
 * validated `10` and shipped `20`, and a second read of `Infinity` sailed
 * through the non-finite check to land as the `null` that check exists to
 * prevent. Not reading it leaves the serializer as the only reader, which is
 * the property that makes "validated" and "sent" the same thing.
 */
function readDataProperty(
  holder: object,
  key: string,
  throughChain = false,
): { accessor: true } | { accessor: false; value: unknown } {
  const visited = new WeakSet<object>();
  let node: object | null = holder;
  while (node !== null) {
    if (visited.has(node)) return { accessor: true };
    visited.add(node);

    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(node, key);
    } catch {
      // A Proxy trap threw. Reflection is caller code too, so this fails the
      // same way the rest of the walk does: skip it, let the serializer say.
      return { accessor: true };
    }
    // The first descriptor found wins, which is how shadowing resolves.
    if (descriptor) {
      if (descriptor.get || descriptor.set) return { accessor: true };
      return { accessor: false, value: descriptor.value };
    }
    if (!throughChain) break;
    try {
      node = Object.getPrototypeOf(node) as object | null;
    } catch {
      return { accessor: true };
    }
  }
  // Nothing defines it: an array hole, which JSON writes as `null`.
  return { accessor: false, value: undefined };
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
