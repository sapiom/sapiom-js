// =============================================================================
// scripts/examples-manifest-check.mjs
//
// The `manifest-schema` half of `pnpm examples:check`: validate every
// `<sourcePath>/template.json` against `examples/template.schema.json`.
//
// Why this lives in the check and not in a behavioural lint: the manifest is
// parsed by the backend with zod's strip-unknown default, so a typo'd field
// name is silently dropped and nobody finds out. `requiredSecrets` was absent
// from the schema for its entire life even though the backend already parsed
// it — an author adding one wrote a field their own CI rejected. Validating the
// manifest is the declaration surface's own proof.
//
// Exported (rather than inlined into examples-check.mjs) so the rules are
// testable against fixtures without shelling out to the whole gate.
// =============================================================================

/**
 * Keys the workflows engine refuses for sandbox env injection, mirroring
 * `apps/workflows-engine/src/platform/vault/workflow-secret-env.ts`. The schema
 * pattern (`^[A-Za-z_][A-Za-z0-9_]{0,255}$`) is the engine's syntax rule; these
 * are the namespace rules it applies on top, and JSON Schema can express them
 * only as an unreadable `not`/pattern pair — so they live here, where the
 * failure can name the offending key.
 */
const RESERVED_SECRET_KEYS = new Set([
  "PATH",
  "__proto__",
  "constructor",
  "prototype",
]);
const RESERVED_SECRET_KEY_PREFIXES = ["SAPIOM_", "WORKFLOWS_"];

/** True when the engine would refuse to inject `key` as process env. */
export function isReservedSecretKey(key) {
  return (
    RESERVED_SECRET_KEYS.has(key) ||
    RESERVED_SECRET_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/**
 * The distinct resource kinds a manifest provisions, sorted — the value
 * `registry.setup.provisions[]` must equal.
 */
export function deriveProvisions(manifest) {
  const resources = Array.isArray(manifest?.resources)
    ? manifest.resources
    : [];
  return [...new Set(resources.map((r) => r?.kind))].filter(Boolean).sort();
}

/** zeroSetup.terminalState values that count as "reaches a meaningful terminal
 * with no setup". A suspend (`paused_for_approval`) or an absent zeroSetup does
 * not — the shelf's "pauses for approval" state is derived from steps[].checkpoint. */
const MEANINGFUL_ZEROSETUP_TERMINALS = new Set([
  "completed",
  "completed_partial",
]);

/**
 * The full `registry.setup` block a template's manifest implies — the single
 * source of truth for `pnpm examples:sync-setup` and the drift check below.
 * Denormalised into the thin registry index so the gallery shelf renders it
 * without fetching a manifest (an N+1 the shelf can't afford).
 *
 *   runsWithNoSetup      — true ONLY when the manifest carries a zeroSetup whose
 *                          terminalState is a meaningful terminal; absent
 *                          zeroSetup (unmeasured / hard-failed / the-brain) ⇒ false.
 *   connectionCount      — number of requiredSecrets ("needs 1 credential").
 *   settingCount         — number of declared settings.
 *   provisions           — deriveProvisions(manifest); included only when non-empty.
 *   degradedWithoutSetup — zeroSetup.narrative verbatim, when present (rendered
 *                          on the card — never implies a send that won't happen).
 */
export function deriveSetup(manifest) {
  const requiredSecrets = Array.isArray(manifest?.requiredSecrets)
    ? manifest.requiredSecrets
    : [];
  const settings = Array.isArray(manifest?.settings) ? manifest.settings : [];
  const zeroSetup = manifest?.zeroSetup;
  const provisions = deriveProvisions(manifest);

  const setup = {
    runsWithNoSetup:
      !!zeroSetup &&
      MEANINGFUL_ZEROSETUP_TERMINALS.has(zeroSetup.terminalState),
    connectionCount: requiredSecrets.length,
    settingCount: settings.length,
  };
  if (provisions.length > 0) setup.provisions = provisions;
  if (
    typeof zeroSetup?.narrative === "string" &&
    zeroSetup.narrative.length > 0
  ) {
    setup.degradedWithoutSetup = zeroSetup.narrative;
  }
  return setup;
}

/** Stable key-sorted serialisation, so two setup blocks compare equal regardless
 * of key order or which optional fields are present. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = canonical(value[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * The registry `setup` block is GENERATED from the manifest by
 * `pnpm examples:sync-setup`. This fails CI when the committed block drifts from
 * what the manifest implies — the same verify-don't-trust rule as provisions,
 * applied to the whole block so it can never be hand-edited out of sync.
 */
export function checkSetupSync(template, manifest) {
  const derived = deriveSetup(manifest);
  const actual = template?.setup;
  if (actual === undefined) {
    return [
      `setup-sync: "${template?.id ?? "(unknown)"}" has no registry setup block — run \`pnpm examples:sync-setup\` (setup is generated from the manifest, never hand-maintained).`,
    ];
  }
  if (
    JSON.stringify(canonical(actual)) === JSON.stringify(canonical(derived))
  ) {
    return [];
  }
  return [
    `setup-sync: "${template?.id ?? "(unknown)"}" registry setup is ${JSON.stringify(actual)} but the manifest derives ${JSON.stringify(derived)} — run \`pnpm examples:sync-setup\`.`,
  ];
}

/**
 * A declared seed that isn't on disk provisions an empty database and reports
 * success — the exact failure `resources[].seed` exists to prevent.
 *
 * @param fileExists  (relativePath) => boolean, resolved against the example dir
 */
export function checkResourceSeeds(templateId, manifest, fileExists) {
  const resources = Array.isArray(manifest?.resources)
    ? manifest.resources
    : [];
  const errors = [];
  resources.forEach((resource, i) => {
    if (typeof resource?.seed !== "string") return;
    if (!fileExists(resource.seed)) {
      errors.push(
        `manifest-resource-seed: "${templateId}" /resources/${i}/seed points at "${resource.seed}", which does not exist in the example directory.`,
      );
    }
  });
  return errors;
}

/**
 * True when `source` reads the injected handle under `key` via
 * `resolveResourceHandle`. The default key (`dbHandle`) is read by any call with
 * no `key` option, so a bare call satisfies it; a non-default key must be named
 * explicitly in the options bag, which is exactly what keeps the declaration and
 * the runtime read from drifting.
 */
function readsInjectedHandle(source, key) {
  if (!/resolveResourceHandle\s*\(/.test(source)) return false;
  if (key === "dbHandle") return true;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`key\\s*:\\s*["']${escaped}["']`).test(source);
}

/**
 * A `reuse` descriptor is the deploy-time picker's permission to offer "use a
 * database you already have" for a resource. It is honest ONLY when the step
 * actually opens the injected handle — otherwise the user picks a database the
 * next run ignores, the dishonest affordance design-v2 § Landmines forbids
 * ("a picker turns a latent hazard into a likely one"). Two rules the schema
 * cannot express:
 *   - reuse is a postgres concept — the picker lists databases, so a marker on a
 *     sandbox / repository / inbox would offer a control with nothing to show.
 *   - the declared `key` must be read by a `resolveResourceHandle(...)` call in
 *     the step code, so a `reuse` marker can never sit on a hardcoded handle.
 *
 * @param indexSource  contents of the template's index.ts, or null when absent.
 */
export function checkResourceReuse(templateId, manifest, indexSource) {
  const resources = Array.isArray(manifest?.resources)
    ? manifest.resources
    : [];
  const errors = [];
  const where = `"${templateId}" template.json`;
  resources.forEach((resource, i) => {
    const reuse = resource?.reuse;
    if (reuse === undefined || reuse === null) return;
    if (resource?.kind !== "postgres") {
      errors.push(
        `manifest-resource-reuse: ${where} /resources/${i} declares \`reuse\` on a "${resource?.kind}" resource — reuse is the postgres "use a database you already have" picker; only postgres resources may carry it.`,
      );
      return;
    }
    const key = reuse?.key;
    if (typeof key !== "string") return; // the descriptor's shape is the schema's job.
    if (indexSource === null) {
      errors.push(
        `manifest-resource-reuse: ${where} /resources/${i} is marked reusable but the template has no index.ts to read the injected "${key}" — a picker would repoint a handle no step opens.`,
      );
      return;
    }
    if (!readsInjectedHandle(indexSource, key)) {
      errors.push(
        `manifest-resource-reuse: ${where} /resources/${i}/reuse/key "${key}" is never read via resolveResourceHandle in index.ts — a reuse descriptor promises the run opens the picked handle, so the step must read it (the SAP-2191 migration pattern). Either wire the read or drop \`reuse\`.`,
      );
    }
  });
  return errors;
}

/**
 * Compile the manifest schema once and return a checker.
 *
 * @param ajv       the Ajv instance already built for the registry check
 * @param schema    parsed examples/template.schema.json
 * @returns (templateId, manifest) => string[] of human-readable problems
 */
export function createManifestChecker(ajv, schema) {
  const validate = ajv.compile(schema);

  return function checkManifest(templateId, manifest) {
    const errors = [];
    const where = `"${templateId}" template.json`;

    // The schema declares `$schema` as an allowed property, so the manifest is
    // validated as authored — no stripping. That is deliberate: an editor hint
    // pointing at the wrong schema is worth catching.
    if (!validate(manifest)) {
      for (const e of validate.errors ?? []) {
        errors.push(
          `manifest-schema: ${where} ${e.instancePath || "/"} ${e.message}.`,
        );
      }
    }

    // Namespace rules the schema pattern cannot express readably. Run even when
    // schema validation failed: the two report different problems with the same
    // field, and an author fixing one should see both.
    const secrets = Array.isArray(manifest?.requiredSecrets)
      ? manifest.requiredSecrets
      : [];
    secrets.forEach((secret, i) => {
      const key = secret?.key;
      if (typeof key === "string" && isReservedSecretKey(key)) {
        errors.push(
          `manifest-secret-key: ${where} /requiredSecrets/${i}/key "${key}" is reserved — a secret key cannot be PATH and cannot start with SAPIOM_ or WORKFLOWS_, because the engine never lets a template override its own namespaces.`,
        );
      }
    });

    // Handles are how step code addresses a resource
    // (`ctx.sapiom.database.get(handle)`), so a duplicate is a silent collision
    // at lookup — the schema can constrain one handle's shape but not their
    // uniqueness as a set.
    const resources = Array.isArray(manifest?.resources)
      ? manifest.resources
      : [];
    const seenHandles = new Map();
    resources.forEach((resource, i) => {
      const handle = resource?.handle;
      if (typeof handle !== "string") return;
      if (seenHandles.has(handle)) {
        errors.push(
          `manifest-resource-handle: ${where} /resources/${i}/handle "${handle}" duplicates /resources/${seenHandles.get(handle)} — step code looks a resource up by handle, so two resources sharing one collide.`,
        );
        return;
      }
      seenHandles.set(handle, i);
    });

    return errors;
  };
}
