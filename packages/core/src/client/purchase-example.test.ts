import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sapiom-purchase-example-"));
  const example = readFileSync(
    resolve(__dirname, "../../examples/saved-method-purchase.mjs"),
    "utf8",
  );
  writeFileSync(
    join(dir, "example.mjs"),
    example.replace('from "@sapiom/core"', 'from "./sdk.mjs"'),
  );
  writeFileSync(
    join(dir, "sdk.mjs"),
    `
    import { appendFileSync } from 'node:fs';
    const record = call => appendFileSync(process.env.CALLS_FILE, JSON.stringify(call)+'\\n');
    export class SapiomApiError extends Error {}
    export class SapiomClient {
      transactions = {
        checkCompatibility: async domain => { record({operation:'check',domain}); throw new Error('discovery unavailable'); },
        create: async (body, options) => { record({operation:'create',body,options}); return {id:'purchase',order:{outcome:'unknown'}}; }
      };
    }
  `,
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fixture(type: "ucp_checkout" | "browser_checkout") {
  const request = {
    purchase: { type, merchant: { origin: "https://shop.example" } },
    funding: { paymentMethodId: "chosen-method" },
  };
  const saved = { idempotencyKey: "retained-purchase-key", request };
  writeFileSync(join(dir, "request.json"), JSON.stringify(saved));
  return {
    saved,
    env: {
      ...process.env,
      SAPIOM_API_KEY: "fixture-only",
      PURCHASE_REQUEST: join(dir, "request.json"),
      CALLS_FILE: join(dir, "calls.jsonl"),
    },
  };
}
const calls = () =>
  readFileSync(join(dir, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

it.each([
  ["browser_checkout", "create"],
  ["ucp_checkout", "create"],
  ["ucp_checkout", "resume"],
] as const)(
  "submits the retained %s request for %s without rechecking live discovery",
  async (type, command) => {
    const { saved, env } = fixture(type);
    const { stdout } = await run(
      process.execPath,
      [join(dir, "example.mjs"), command],
      { env },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      id: "purchase",
      order: { outcome: "unknown" },
    });
    expect(calls()).toEqual([
      {
        operation: "create",
        body: saved.request,
        options: { idempotencyKey: saved.idempotencyKey },
      },
    ]);
  },
);

it("keeps compatibility discovery as an explicit non-purchasing command", async () => {
  const { env } = fixture("ucp_checkout");
  await expect(
    run(process.execPath, [join(dir, "example.mjs"), "check"], { env }),
  ).rejects.toMatchObject({ code: 1 });
  expect(calls()).toEqual([
    { operation: "check", domain: "https://shop.example" },
  ]);
});
