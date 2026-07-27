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

    return errors;
  };
}
