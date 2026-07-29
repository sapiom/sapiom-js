// =============================================================================
// scripts/examples-discipline-check.mjs
//
// `discipline` must sit under its row's `category`.
//
// The two fields are the same OUTCOME axis at two zoom levels: `category` groups
// the gallery rail, `discipline` labels the individual card. That only holds if
// they agree — a `Support` badge on a `finance-legal-people` row puts the card in
// one place and describes it as another, and the gallery has no way to tell which
// is the lie.
//
// This cannot live in registry.schema.json. Both fields are closed enums there,
// but the constraint is BETWEEN them, and draft-07 expresses that only as a
// seven-branch `allOf`/`if`/`then` whose failure message names a subschema index
// rather than the offending word. The map below is the same information in the
// form an author can read.
//
// The enum in the schema is deliberately the UNION across every category, not
// the set valid for any one of them — so the schema alone accepts a mismatch and
// this check is what rejects it.
// =============================================================================

/**
 * Disciplines allowed under each `category` id.
 *
 * `Operations` appears twice on purpose: the data and the finance/legal/people
 * sides of the catalog both have run-the-business work that is not Data,
 * Knowledge, Finance, Legal, or People, and forcing it into one of those would
 * mislabel the card to keep this map one-to-one.
 *
 * Adding a discipline means adding it here AND to the enum in
 * `examples/registry.schema.json`; a value in only one place is a check failure,
 * which is the intended outcome.
 */
export const DISCIPLINE_BY_CATEGORY = {
  starter: ["Starter"],
  "product-engineering": ["Engineering", "Release engineering", "AI operations"],
  "reliability-governance": ["Reliability", "Security", "Governance", "FinOps"],
  "revenue-marketing": ["Revenue", "Marketing", "Strategy"],
  "customer-experience": ["Support", "Customer success", "Product"],
  "data-knowledge": ["Data", "Knowledge", "Research", "Operations"],
  "finance-legal-people": ["Finance", "Legal", "People", "Operations"],
};

/**
 * Cross-field discipline rules for one template.
 *
 * Silent when either field is absent: both are optional, and "missing" is a
 * separate nudge in examples-check.mjs. Silent too when `category` is not a
 * known id — that is check 1's job, and reporting it twice would bury the real
 * error under a consequence of it.
 *
 * @param template  the registry entry (id, category, discipline)
 * @returns string[] of problems, each naming the template and the allowed set
 */
export function checkDiscipline(template) {
  const discipline = template?.discipline;
  const category = template?.category;
  if (typeof discipline !== "string" || typeof category !== "string") return [];

  const allowed = DISCIPLINE_BY_CATEGORY[category];
  if (!allowed) return [];
  if (allowed.includes(discipline)) return [];

  return [
    `discipline: "${template?.id ?? "(unknown)"}" is category "${category}" but discipline "${discipline}" — ` +
      `that pair does not exist. Allowed under "${category}": ${allowed.join(", ")}. ` +
      `Change whichever one is wrong; do not add the pair unless the taxonomy really grew.`,
  ];
}
