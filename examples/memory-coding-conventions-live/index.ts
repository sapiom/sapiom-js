/**
 * memory-coding-conventions-LIVE
 * ------------------------------
 * The LIVE sibling of ../memory-coding-conventions.
 *
 * The original example is a teaching artifact: it runs `runLocal` against a STUB
 * engine + STUB gateway (no network, no credentials). It can NEVER reach a real
 * memory engine, because `runLocal` is hardwired to @sapiom/tools/stub.
 *
 * THIS file does the opposite: it uses the REAL `@sapiom/tools` memory client and
 * hits a REAL memory engine. Point it at your LOCAL unified-gateway memory provider
 * (the sapiom-local stack) with two env vars:
 *
 *   SAPIOM_MEMORY_URL = http://memory.services.localhost:3100
 *   SAPIOM_API_KEY    = <a real Sapiom API key from your LOCAL backend>
 *
 * NOTE — this costs money / x402: `recall` and `append` are x402-PAID operations.
 * The account behind SAPIOM_API_KEY must be able to pay (the gateway resolves your
 * identity + payment context by calling back to the Sapiom backend). `get` and
 * `forget` are free for identified callers.
 *
 * Run:
 *   cd examples/memory-coding-conventions-live
 *   npm install
 *   SAPIOM_MEMORY_URL=http://memory.services.localhost:3100 \
 *   SAPIOM_API_KEY=sk_... \
 *   npm start
 *
 * This mirrors the same recall -> inject -> append loop as the stub example, but
 * every call crosses the wire to the gateway, embeds via real OpenRouter, and
 * reads/writes a real per-tenant pgvector store on Neon.
 */

import { memory } from "@sapiom/tools";

const SCOPE = "house-conventions";

function assertEnv() {
  if (!process.env.SAPIOM_MEMORY_URL) {
    throw new Error("Set SAPIOM_MEMORY_URL (e.g. http://memory.services.localhost:3100)");
  }
  if (!process.env.SAPIOM_API_KEY) {
    throw new Error("Set SAPIOM_API_KEY to a real Sapiom API key from your local backend");
  }
}

async function main() {
  assertEnv();
  const task = "Write a TypeScript service method that loads a user by id.";

  // 1) RECALL — pull prior conventions for this scope (identity-gated; not charged today)
  const { results, count } = await memory.recall({ query: task, scope: SCOPE, topK: 5 });
  console.log(`recall  -> ${count} prior memories for scope="${SCOPE}"`);

  // 2) INJECT — fold recalled conventions into the agent prompt
  const conventions = results.map((m, i) => `  ${i + 1}. ${m.content}`).join("\n");
  const enrichedTask = conventions
    ? `${task}\n\nFollow these house conventions:\n${conventions}`
    : task;
  console.log("inject  -> enriched task:\n" + enrichedTask + "\n");

  // (A real coding agent would run here against `enrichedTask`. Omitted: this
  //  demo isolates the memory loop, not the agent.)

  // 3) APPEND — persist a new convention learned this run (x402-paid)
  const learned = "Inject DataSource and pass EntityManager through service methods; never use @InjectRepository.";
  const appended = await memory.append({
    content: learned,
    scope: SCOPE,
    metadata: { source: "memory-coding-conventions-live" },
  });
  console.log(
    `append  -> id=${appended.id} decision=${appended.decision}` +
      (appended.supersededId ? ` supersededId=${appended.supersededId}` : "") +
      (appended.similarityScore != null ? ` similarity=${appended.similarityScore}` : ""),
  );

  // 3b) APPEND a NEAR-DUPLICATE — expect decision=SUPERSEDED (cosine >= 0.80)
  const nearDup = await memory.append({
    content: "Always inject the DataSource; do not use @InjectRepository in services.",
    scope: SCOPE,
    metadata: { source: "memory-coding-conventions-live", variant: "near-duplicate" },
  });
  console.log(`append2 -> decision=${nearDup.decision} supersededId=${nearDup.supersededId ?? "-"}`);

  // 3c) APPEND a SECRET — expect the gateway to REJECT (HTTP 400, decision REJECTED)
  // Assembled so secret-scanners don't flag this intentional fake key; the gate still sees the full value at runtime.
  const LEAKED_SECRET = ["sk", "live", "51HxYzAbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("_");
  try {
    await memory.append({
      content: `Prod DB password is ${LEAKED_SECRET}`,
      scope: SCOPE,
    });
    console.log("append3 -> UNEXPECTED: secret was accepted (should have been REJECTED)");
  } catch (err) {
    console.log(`append3 -> REJECTED as expected: ${(err as Error).message}`);
  }

  // 4) GET (free for identified callers)
  const fetched = await memory.get(appended.id);
  console.log(`get     -> id=${fetched.id} status=${fetched.status}`);

  // 5) FORGET, then FORGET AGAIN — forget is a hard delete but idempotent, so the
  //    second call of the now-gone id succeeds too (204 No Content, not a 404).
  await memory.forget(appended.id);
  console.log(`forget  -> deleted ${appended.id}`);
  try {
    await memory.forget(appended.id);
    console.log("forget2 -> OK as expected: second forget succeeded (idempotent 204)");
  } catch (err) {
    console.log(`forget2 -> UNEXPECTED error (idempotent forget should succeed): ${(err as Error).message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
