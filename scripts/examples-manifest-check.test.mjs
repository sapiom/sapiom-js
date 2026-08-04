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
import {
  checkResourceReuse,
  checkResourceSeeds,
  checkSetupSync,
  createManifestChecker,
  deriveProvisions,
  deriveSetup,
} from "./examples-manifest-check.mjs";

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
  assert.equal(
    registry.templates.length,
    11,
    "the curated gallery is exactly 11 — update this floor and the copy gate deliberately when the set changes (culled dirs still on disk must not silently regrow it)",
  );
});

test("the copy length caps are enforced by the schema, with a pointer", () => {
  const cases = [
    [
      { whatItDoes: "Create ".repeat(60) },
      /\/whatItDoes must NOT have more than 320 characters/,
    ],
    [
      { useCases: ["x".repeat(41)] },
      /\/useCases\/0 must NOT have more than 40 characters/,
    ],
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

test("a fully declared resource is valid", () => {
  assert.deepEqual(
    check({
      resources: [
        {
          kind: "postgres",
          handle: "reports-db",
          duration: "7d",
          seed: "seed.sql",
        },
        { kind: "sandbox", handle: "renderer", ephemeral: true },
      ],
    }),
    [],
  );
});

test("a resource missing kind or handle fails", () => {
  assert.match(
    check({ resources: [{ handle: "db" }] })[0],
    /\/resources\/0 must have required property 'kind'/,
  );
  assert.match(
    check({ resources: [{ kind: "postgres" }] })[0],
    /\/resources\/0 must have required property 'handle'/,
  );
});

test("a resource kind outside the closed vocabulary fails", () => {
  const errors = check({ resources: [{ kind: "kafka", handle: "bus" }] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\/resources\/0\/kind must be equal to one of/);
});

test("a duration outside the offered lifetimes fails", () => {
  // 7d is the ceiling and there is no renew verb, so "30d" must not be quietly
  // accepted — it would read as a durability promise the platform cannot keep.
  const errors = check({
    resources: [{ kind: "postgres", handle: "db", duration: "30d" }],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\/resources\/0\/duration must be equal to one of/);
});

test("a handle that is not a lookup-safe slug fails", () => {
  for (const handle of ["Reports_DB", "-leading", "has space"]) {
    const errors = check({ resources: [{ kind: "postgres", handle }] });
    assert.equal(errors.length, 1, `${handle} → ${errors.join("; ")}`);
    assert.match(errors[0], /\/resources\/0\/handle must match pattern/);
  }
});

test("two resources sharing a handle fail — step code looks up by handle", () => {
  const errors = check({
    resources: [
      { kind: "postgres", handle: "store" },
      { kind: "sandbox", handle: "store" },
    ],
  });
  assert.deepEqual(errors, [
    `manifest-resource-handle: "fixture" template.json /resources/1/handle "store" duplicates /resources/0 — step code looks a resource up by handle, so two resources sharing one collide.`,
  ]);
});

test("a resource naming a storage location fails", () => {
  // Same rule as requiredSecrets: a declaration says what a thing IS.
  const errors = check({
    resources: [{ kind: "postgres", handle: "db", vaultRef: "workflow:x" }],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\/resources\/0 must NOT have additional properties/);
});

// --- reuse descriptor (the deploy-time "use my own database" picker) --------

test("a resource with a fully declared reuse descriptor is valid", () => {
  assert.deepEqual(
    check({
      resources: [
        { kind: "postgres", handle: "db", reuse: { key: "dbHandle" } },
      ],
    }),
    [],
  );
});

test("a reuse descriptor missing key fails", () => {
  assert.deepEqual(
    check({ resources: [{ kind: "postgres", handle: "db", reuse: {} }] }),
    [
      `manifest-schema: "fixture" template.json /resources/0/reuse must have required property 'key'.`,
    ],
  );
});

test("a reuse descriptor with an extra property fails", () => {
  const errors = check({
    resources: [
      {
        kind: "postgres",
        handle: "db",
        reuse: { key: "dbHandle", copy: true },
      },
    ],
  });
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /\/resources\/0\/reuse must NOT have additional properties/,
  );
});

test("a reuse key that is a dotted path fails — the seam reads a top-level key", () => {
  const errors = check({
    resources: [
      { kind: "postgres", handle: "db", reuse: { key: "config.dbHandle" } },
    ],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\/resources\/0\/reuse\/key must match pattern/);
});

// checkResourceReuse is the semantic half — reuse is postgres-only, and its key
// must actually be read via resolveResourceHandle in the step code.
const READS_DEFAULT = `const h = resolveResourceHandle(input, { fallback: DEFAULT_DB_HANDLE });`;
const READS_LEDGER = `resolveResourceHandle(input, { key: "ledgerHandle", fallback: "" });`;
const HARDCODED = `const DB_HANDLE = "the-brain"; const h = DB_HANDLE;`;

test("checkResourceReuse: a reuse marker on a non-postgres resource fails", () => {
  const errors = checkResourceReuse(
    "fixture",
    {
      resources: [{ kind: "sandbox", handle: "s", reuse: { key: "dbHandle" } }],
    },
    READS_DEFAULT,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /only postgres resources may carry it/);
});

test("checkResourceReuse: a reusable resource whose handle the code hardcodes fails", () => {
  const errors = checkResourceReuse(
    "fixture",
    {
      resources: [
        { kind: "postgres", handle: "db", reuse: { key: "dbHandle" } },
      ],
    },
    HARDCODED,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /never read via resolveResourceHandle/);
});

test("checkResourceReuse: the default key is satisfied by a bare resolveResourceHandle call", () => {
  assert.deepEqual(
    checkResourceReuse(
      "fixture",
      {
        resources: [
          { kind: "postgres", handle: "db", reuse: { key: "dbHandle" } },
        ],
      },
      READS_DEFAULT,
    ),
    [],
  );
});

test("checkResourceReuse: a non-default key must be named explicitly in the options bag", () => {
  const drift = checkResourceReuse(
    "fixture",
    {
      resources: [
        { kind: "postgres", handle: "db", reuse: { key: "ledgerHandle" } },
      ],
    },
    READS_DEFAULT, // reads dbHandle, not ledgerHandle
  );
  assert.equal(drift.length, 1);
  assert.match(drift[0], /never read via resolveResourceHandle/);
  assert.deepEqual(
    checkResourceReuse(
      "fixture",
      {
        resources: [
          { kind: "postgres", handle: "db", reuse: { key: "ledgerHandle" } },
        ],
      },
      READS_LEDGER,
    ),
    [],
  );
});

test("checkResourceReuse: a reusable resource with no index.ts fails", () => {
  const errors = checkResourceReuse(
    "fixture",
    {
      resources: [
        { kind: "postgres", handle: "db", reuse: { key: "dbHandle" } },
      ],
    },
    null,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no index\.ts/);
});

// Loophole 1: a declared default key must be read by a call that actually reads
// the default — not credited just because *some* resolveResourceHandle call
// exists. Here the only call reads a different key.
test("checkResourceReuse: a declared dbHandle is not satisfied by a call reading another key", () => {
  const errors = checkResourceReuse(
    "fixture",
    {
      resources: [
        { kind: "postgres", handle: "db", reuse: { key: "dbHandle" } },
      ],
    },
    `const h = resolveResourceHandle(input, { key: "somethingElse", fallback: "" });`,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /never read via resolveResourceHandle/);
});

// Loophole 2: the declared key appearing only in a comment (or any text outside
// a real call's arguments) must NOT satisfy the check — the exact shape this
// PR's own templates carry, e.g. `reuse.key: "ledgerHandle"` in a doc comment.
test("checkResourceReuse: a key named only in a comment does not count as read", () => {
  const commentOnly = [
    `// declared as \`resources[].reuse.key: "ledgerHandle"\``,
    `const h = resolveResourceHandle(input, { fallback: "" }); // reads dbHandle`,
  ].join("\n");
  const errors = checkResourceReuse(
    "fixture",
    {
      resources: [
        { kind: "postgres", handle: "db", reuse: { key: "ledgerHandle" } },
      ],
    },
    commentOnly,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /never read via resolveResourceHandle/);
});

test("checkResourceReuse: an internal-state resource with no reuse marker is fine", () => {
  // the-brain: hardcoded handle, no reuse descriptor ⇒ no picker, no error.
  assert.deepEqual(
    checkResourceReuse(
      "fixture",
      { resources: [{ kind: "postgres", handle: "the-brain" }] },
      HARDCODED,
    ),
    [],
  );
});

test("checkResourceReuse passes for every real reusable manifest against its index.ts", () => {
  const registry = JSON.parse(
    readFileSync(path.join(ROOT, "examples", "registry.json"), "utf8"),
  );
  for (const t of registry.templates) {
    const dir = path.join(ROOT, t.sourcePath ?? path.join("examples", t.id));
    let manifest;
    try {
      manifest = JSON.parse(
        readFileSync(path.join(dir, "template.json"), "utf8"),
      );
    } catch {
      continue;
    }
    const indexPath = path.join(dir, "index.ts");
    let indexSource = null;
    try {
      indexSource = readFileSync(indexPath, "utf8");
    } catch {
      indexSource = null;
    }
    assert.deepEqual(
      checkResourceReuse(t.id, manifest, indexSource),
      [],
      `${t.id} declares a reuse descriptor its step code does not honor`,
    );
  }
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

test("provisions derive as distinct kinds, sorted", () => {
  assert.deepEqual(deriveProvisions({}), []);
  assert.deepEqual(
    deriveProvisions({
      resources: [
        { kind: "sandbox", handle: "a" },
        { kind: "postgres", handle: "b" },
        { kind: "sandbox", handle: "c" },
      ],
    }),
    ["postgres", "sandbox"],
  );
});

test("a seed file that does not exist fails", () => {
  const errors = checkResourceSeeds(
    "fixture",
    { resources: [{ kind: "postgres", handle: "db", seed: "seed.sql" }] },
    () => false,
  );
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /^manifest-resource-seed: "fixture" \/resources\/0\/seed points at "seed\.sql"/,
  );
});

test("a seed file that exists passes, and no seed is not a problem", () => {
  const resources = [{ kind: "postgres", handle: "db", seed: "seed.sql" }];
  assert.deepEqual(
    checkResourceSeeds("fixture", { resources }, () => true),
    [],
  );
  assert.deepEqual(
    checkResourceSeeds(
      "fixture",
      { resources: [{ kind: "sandbox", handle: "s" }] },
      () => false,
    ),
    [],
  );
});

test("no declaration field names a storage location", () => {
  const declarations = [
    "requiredSecrets",
    "settings",
    "resources",
    "zeroSetup",
  ];
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

// --- setup derivation + drift (examples:sync-setup) ------------------------

test("deriveSetup: a meaningful zeroSetup terminal ⇒ runsWithNoSetup true, narrative mirrored", () => {
  const setup = deriveSetup({
    requiredSecrets: [{ key: "A" }],
    settings: [{ path: "x" }, { path: "y" }],
    zeroSetup: {
      terminalState: "completed_partial",
      narrative: "did the honest thing",
    },
  });
  assert.equal(setup.runsWithNoSetup, true);
  assert.equal(setup.connectionCount, 1);
  assert.equal(setup.settingCount, 2);
  assert.equal(setup.degradedWithoutSetup, "did the honest thing");
});

test("deriveSetup: terminalState 'completed' ⇒ runsWithNoSetup true", () => {
  // Symmetry with the completed_partial case above: both non-suspend terminals
  // in the enum are meaningful, so the other literal gets its own assertion.
  const setup = deriveSetup({
    zeroSetup: { terminalState: "completed", narrative: "ran clean" },
  });
  assert.equal(setup.runsWithNoSetup, true);
  assert.equal(setup.degradedWithoutSetup, "ran clean");
});

test("deriveSetup: no zeroSetup ⇒ runsWithNoSetup false and no degradedWithoutSetup", () => {
  const setup = deriveSetup({ requiredSecrets: [{ key: "A" }] });
  assert.equal(setup.runsWithNoSetup, false);
  assert.equal(setup.connectionCount, 1);
  assert.equal(setup.settingCount, 0);
  assert.ok(!("degradedWithoutSetup" in setup));
  assert.ok(!("provisions" in setup));
});

test("deriveSetup: a suspend (paused_for_approval) is not runsWithNoSetup", () => {
  const setup = deriveSetup({
    zeroSetup: { terminalState: "paused_for_approval", narrative: "waits" },
  });
  assert.equal(setup.runsWithNoSetup, false);
});

test("deriveSetup: provisions are the distinct sorted resource kinds, only when present", () => {
  const setup = deriveSetup({
    resources: [
      { kind: "sandbox" },
      { kind: "postgres" },
      { kind: "postgres" },
    ],
    zeroSetup: { terminalState: "completed" },
  });
  assert.deepEqual(setup.provisions, ["postgres", "sandbox"]);
});

test("checkSetupSync: a block matching the manifest passes; drift and absence fail", () => {
  const manifest = {
    requiredSecrets: [{ key: "A" }],
    zeroSetup: { terminalState: "completed", narrative: "n" },
  };
  const inSync = { id: "t", setup: deriveSetup(manifest) };
  assert.deepEqual(checkSetupSync(inSync, manifest), []);

  const drift = {
    id: "t",
    setup: { ...deriveSetup(manifest), connectionCount: 99 },
  };
  assert.equal(checkSetupSync(drift, manifest).length, 1);
  assert.match(checkSetupSync(drift, manifest)[0], /setup-sync/);

  assert.equal(checkSetupSync({ id: "t" }, manifest).length, 1);
});

test("checkSetupSync passes for every real manifest against the committed registry", () => {
  const registry = JSON.parse(
    readFileSync(path.join(ROOT, "examples", "registry.json"), "utf8"),
  );
  for (const t of registry.templates) {
    const dir = path.join(ROOT, t.sourcePath ?? path.join("examples", t.id));
    const manifestPath = path.join(dir, "template.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue; // no manifest ⇒ flagged by a different gate
    }
    assert.deepEqual(
      checkSetupSync(t, manifest),
      [],
      `${t.id} registry setup is out of sync — run pnpm examples:sync-setup`,
    );
  }
});
