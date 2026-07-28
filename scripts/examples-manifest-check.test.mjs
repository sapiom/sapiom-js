// =============================================================================
// scripts/examples-manifest-check.test.mjs
//
// Fixture tests for the `manifest-schema` gate. These are the proof that the
// declaration surface is actually enforced — the whole point of SAP-2076 is that
// a field the schema doesn't know about is silently stripped downstream, so
// every negative case below is a bug that used to ship.
//
// Run:  pnpm examples:check:test   (node --test)
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Ajv from "ajv";
import { createManifestChecker } from "./examples-manifest-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestSchema = JSON.parse(
  readFileSync(path.join(ROOT, "examples", "template.schema.json"), "utf8"),
);

// Same construction as examples-check.mjs, so the tests exercise the real gate.
const checkManifest = createManifestChecker(
  new Ajv({ allErrors: true, strict: false }),
  manifestSchema,
);

/** A minimal valid manifest, plus whatever the case under test adds. */
const manifest = (extra) => ({ manifestVersion: 1, ...extra });

const check = (extra) => checkManifest("fixture", manifest(extra));

test("a bare manifest is valid", () => {
  assert.deepEqual(check({}), []);
});

test("every existing manifest in the repo validates unchanged", () => {
  const registry = JSON.parse(
    readFileSync(path.join(ROOT, "examples", "registry.json"), "utf8"),
  );
  const problems = [];
  for (const t of registry.templates) {
    const file = path.join(ROOT, t.sourcePath, "template.json");
    problems.push(
      ...checkManifest(t.id, JSON.parse(readFileSync(file, "utf8"))),
    );
  }
  assert.deepEqual(problems, []);
  assert.ok(registry.templates.length >= 26);
});

test("the copy length caps are enforced by the schema, with a pointer", () => {
  const cases = [
    [{ whatItDoes: "Create ".repeat(60) }, /\/whatItDoes must NOT have more than 320 characters/],
    [{ useCases: ["x".repeat(41)] }, /\/useCases\/0 must NOT have more than 40 characters/],
  ];
  for (const [extra, expected] of cases) {
    const errors = check(extra);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], expected);
  }
});

test("a typo'd top-level field fails rather than being silently stripped", () => {
  const errors = check({ requiredSecret: [] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^manifest-schema: "fixture" template\.json /);
  assert.match(errors[0], /must NOT have additional properties/);
});

test("a typo'd field inside a declaration fails", () => {
  const errors = check({
    requiredSecrets: [
      {
        key: "SLACK_TOKEN",
        label: "Slack token",
        provider: "slack",
        docUrl: "x",
      },
    ],
  });
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /\/requiredSecrets\/0 must NOT have additional properties/,
  );
});

test("failure messages name the template, the JSON pointer, and what is wrong", () => {
  const errors = check({
    requiredSecrets: [{ key: "SLACK_TOKEN", provider: "slack" }],
  });
  assert.deepEqual(errors, [
    `manifest-schema: "fixture" template.json /requiredSecrets/0 must have required property 'label'.`,
  ]);
});

test("a requiredSecrets entry missing provider fails", () => {
  const errors = check({
    requiredSecrets: [{ key: "SLACK_TOKEN", label: "Slack token" }],
  });
  assert.deepEqual(errors, [
    `manifest-schema: "fixture" template.json /requiredSecrets/0 must have required property 'provider'.`,
  ]);
});

test("a fully declared requiredSecrets entry is valid", () => {
  assert.deepEqual(
    check({
      requiredSecrets: [
        {
          key: "SLACK_BOT_TOKEN",
          label: "Slack bot token",
          provider: "slack",
          credentialKind: "bearer_token",
          description: "Create one at api.slack.com/apps.",
          docsUrl: "https://api.slack.com/authentication/token-types",
          optional: true,
        },
      ],
    }),
    [],
  );
});

test("a credentialKind outside the closed vocabulary fails", () => {
  const errors = check({
    requiredSecrets: [
      { key: "DB", label: "DB", provider: "postgres", credentialKind: "oauth" },
    ],
  });
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /\/requiredSecrets\/0\/credentialKind must be equal to one of/,
  );
});

for (const key of ["PATH", "SAPIOM_TOKEN", "WORKFLOWS_RUN_ID"]) {
  test(`a reserved secret key (${key}) fails`, () => {
    const errors = check({
      requiredSecrets: [{ key, label: "Nope", provider: "acme" }],
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^manifest-secret-key: "fixture" template\.json /);
    assert.match(
      errors[0],
      new RegExp(`/requiredSecrets/0/key "${key}" is reserved`),
    );
  });
}

test("a secret key that violates the env-name pattern fails", () => {
  const errors = check({
    requiredSecrets: [{ key: "9-lives", label: "Nope", provider: "acme" }],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\/requiredSecrets\/0\/key must match pattern/);
});

test("a settings entry missing default fails", () => {
  const errors = check({
    settings: [{ path: "deliverTo", label: "Recipient", type: "email" }],
  });
  assert.deepEqual(errors, [
    `manifest-schema: "fixture" template.json /settings/0 must have required property 'default'.`,
  ]);
});

test("a settings default of false or empty string counts as declared", () => {
  assert.deepEqual(
    check({
      settings: [
        { path: "dryRun", label: "Dry run", type: "boolean", default: false },
        { path: "subject", label: "Subject", type: "string", default: "" },
      ],
    }),
    [],
  );
});

test("a settings type outside the closed vocabulary fails", () => {
  const errors = check({
    settings: [{ path: "when", label: "When", type: "date", default: "today" }],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\/settings\/0\/type must be equal to one of/);
});

test("a non-dotted settings path fails", () => {
  const errors = check({
    settings: [
      {
        path: "client.email[0]",
        label: "Email",
        type: "email",
        default: "a@b.c",
      },
    ],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\/settings\/0\/path must match pattern/);
});

test("a zeroSetup.expect assert outside the closed vocabulary fails", () => {
  const errors = check({
    zeroSetup: {
      terminalState: "completed",
      expect: [{ path: "digest.sources", assert: "isTruthy" }],
    },
  });
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /\/zeroSetup\/expect\/0\/assert must be equal to one of/,
  );
});

test("zeroSetup requires a terminalState", () => {
  const errors = check({ zeroSetup: { narrative: "Produces the digest." } });
  assert.deepEqual(errors, [
    `manifest-schema: "fixture" template.json /zeroSetup must have required property 'terminalState'.`,
  ]);
});

test("a fully declared zeroSetup is valid", () => {
  assert.deepEqual(
    check({
      zeroSetup: {
        terminalState: "completed_partial",
        expect: [
          { path: "digest.sources", assert: "nonEmptyArray" },
          { path: "digest.body", assert: "minLength", value: 200 },
          { path: "delivery.messageId", assert: "absent" },
        ],
        narrative:
          "Produces the digest and attaches it to the run; sends nothing.",
      },
    }),
    [],
  );
});

test("defaultInput is an object and coexists with examples[0].input", () => {
  assert.deepEqual(
    check({
      defaultInput: { topic: "Sapiom" },
      examples: [{ input: { topic: "my-app", repoSlug: "my-app" } }],
    }),
    [],
  );
  const errors = check({ defaultInput: "topic=Sapiom" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\/defaultInput must be object/);
});

test("no declaration field names a storage location", () => {
  const declarations = ["requiredSecrets", "settings", "zeroSetup"];
  const forbidden = ["vaultRef", "connectorId", "store"];
  const names = JSON.stringify(
    declarations.map((d) => manifestSchema.properties[d]),
  );
  for (const field of forbidden) {
    assert.ok(
      !names.includes(`"${field}"`),
      `${field} must never appear in a declaration — a declaration says what the credential is, never where it is stored.`,
    );
  }
});
