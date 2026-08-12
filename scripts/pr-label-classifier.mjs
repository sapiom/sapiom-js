const TYPE_OPTIONS = Object.freeze([
  { text: "Bug fix", label: "bug" },
  { text: "Documentation", label: "documentation" },
  { text: "Feature", label: "enhancement" },
  { text: "Tests", label: "testing" },
  { text: "Dependency update", label: "dependencies" },
  { text: "Maintenance or refactor", label: "maintenance" },
]);

export const TYPE_LABELS = Object.freeze(
  TYPE_OPTIONS.map(({ label }) => label),
);

export const CONTRIBUTOR_LABELS = Object.freeze([
  "contributor: trusted",
  "contributor: external",
]);

const LEGACY_CONTRIBUTOR_LABELS = Object.freeze(["contributor: member"]);

export const SIZE_LABELS = Object.freeze([
  "size: small",
  "size: medium",
  "size: large",
  "size: xlarge",
]);

const CLASSIFICATION_LABELS = Object.freeze([
  ...CONTRIBUTOR_LABELS,
  ...LEGACY_CONTRIBUTOR_LABELS,
  ...SIZE_LABELS,
  "contribution: incomplete",
  "review: sensitive",
  "review: manual",
]);

const REQUIRED_SECTIONS = Object.freeze([
  "Problem and motivation",
  "Summary and scope",
  "Related work",
  "Validation",
  "Tests and documentation",
  "Compatibility and release impact",
  "Security",
  "AI assistance",
  "Checklist",
]);

const CHECKLIST_PREFIXES = Object.freeze([
  "i read `contributing.md`",
  "this pull request addresses one focused problem",
  "i added or updated tests",
  "i ran the relevant build",
  "i updated documentation",
  "i added a changeset",
  "i can explain and maintain every submitted change",
]);

const SECURITY_PREFIXES = Object.freeze([
  "i have not included secrets",
  "this pull request does not publicly disclose a suspected vulnerability",
]);

const AI_PREFIXES = Object.freeze([
  "i did not use ai assistance",
  "i used ai assistance",
]);

function normalizeHeading(value) {
  return String(value)
    .replace(/\s+#+\s*$/, "")
    .trim()
    .toLowerCase();
}

function extractSection(body, heading) {
  const source = String(body ?? "");
  const headings = [...source.matchAll(/^(#{2,6})[ \t]+(.+?)[ \t]*$/gm)].map(
    (match) => ({
      index: match.index,
      end: match.index + match[0].length,
      title: normalizeHeading(match[2]),
    }),
  );

  const wanted = normalizeHeading(heading);
  const sectionIndex = headings.findIndex(({ title }) => title === wanted);
  if (sectionIndex === -1) return null;

  const current = headings[sectionIndex];
  const next = headings[sectionIndex + 1];
  return source.slice(current.end, next?.index ?? source.length);
}

function cleanSection(section) {
  return String(section ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^[ \t]*```[^\n]*$/gm, "")
    .replace(/^[ \t]*# command\s+[—-]\s+result[ \t]*$/gim, "")
    .trim();
}

function parseCheckboxes(section) {
  return [
    ...String(section ?? "").matchAll(
      /^[ \t]*[-*][ \t]+\[([ xX])\][ \t]+(.+?)[ \t]*$/gm,
    ),
  ].map((match) => ({
    checked: match[1].toLowerCase() === "x",
    text: match[2].replace(/\s+/g, " ").trim(),
  }));
}

function normalizeCheckboxText(value) {
  return String(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function checkboxForPrefix(checkboxes, prefix) {
  const normalizedPrefix = normalizeCheckboxText(prefix);
  return checkboxes.filter(({ text }) =>
    normalizeCheckboxText(text).startsWith(normalizedPrefix),
  );
}

function validateExpectedCheckboxes(section, prefixes, selectionCount) {
  const checkboxes = parseCheckboxes(section);
  const expected = prefixes.map((prefix) =>
    checkboxForPrefix(checkboxes, prefix),
  );
  if (expected.some((matches) => matches.length !== 1)) return false;

  const expectedCheckboxes = expected.map(([checkbox]) => checkbox);
  return (
    expectedCheckboxes.filter(({ checked }) => checked).length ===
    selectionCount
  );
}

function isCheckboxChecked(section, prefix) {
  const matches = checkboxForPrefix(parseCheckboxes(section), prefix);
  return matches.length === 1 && matches[0].checked;
}

function stripCheckboxes(section) {
  return cleanSection(section)
    .replace(/^[ \t]*[-*][ \t]+\[[ xX]\][ \t]+.*(?:\n|$)/gm, "")
    .trim();
}

function parseNa(value) {
  const match = String(value)
    .trim()
    .match(/^(?:n\/?a|not applicable)\b[\s.:—-]*(.*)$/i);
  if (!match) return { isNa: false, hasReason: false };
  return { isNa: true, hasReason: match[1].trim().length > 0 };
}

function hasSubstantiveText(
  section,
  { allowBareNa = false, allowNaWithReason = false } = {},
) {
  const cleaned = cleanSection(section);
  if (!cleaned) return false;

  const na = parseNa(cleaned);
  if (!na.isNa) return true;
  if (allowBareNa) return true;
  return allowNaWithReason && na.hasReason;
}

function extractRelatedWork(section) {
  return cleanSection(section).replace(
    /^[ \t]*Related issue or discussion:[ \t]*/im,
    "",
  );
}

function extractCompatibilityValue(section, field) {
  const cleaned = cleanSection(section);
  const expression = new RegExp(
    `^[ \\t]*-[ \\t]+${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[ \\t]*(.+)$`,
    "im",
  );
  return cleaned.match(expression)?.[1]?.trim() ?? "";
}

function parsePrimaryType(body) {
  const section = extractSection(body, "Primary change type");
  if (section === null) {
    return { valid: false, label: null };
  }

  const checkboxes = parseCheckboxes(section);
  const options = TYPE_OPTIONS.map(({ text, label }) => ({
    label,
    matches: checkboxForPrefix(checkboxes, text),
  }));
  if (
    checkboxes.length !== TYPE_OPTIONS.length ||
    options.some(({ matches }) => matches.length !== 1)
  ) {
    return { valid: false, label: null };
  }

  const selected = options.filter(
    ({ matches: [checkbox] }) => checkbox.checked,
  );
  return selected.length === 1
    ? { valid: true, label: selected[0].label }
    : { valid: false, label: null };
}

export function validatePullRequestTemplate(body) {
  const source = String(body ?? "");
  const reasons = [];
  const sections = Object.fromEntries(
    REQUIRED_SECTIONS.map((heading) => [
      heading,
      extractSection(source, heading),
    ]),
  );

  for (const [heading, section] of Object.entries(sections)) {
    if (section === null) reasons.push(`Missing section: ${heading}`);
  }

  const primaryType = parsePrimaryType(source);
  if (!primaryType.valid) {
    reasons.push("Select exactly one primary change type");
  }

  if (!hasSubstantiveText(sections["Problem and motivation"])) {
    reasons.push("Problem and motivation is empty");
  }
  if (!hasSubstantiveText(sections["Summary and scope"])) {
    reasons.push("Summary and scope is empty");
  }
  if (
    !hasSubstantiveText(extractRelatedWork(sections["Related work"]), {
      allowBareNa: true,
    })
  ) {
    reasons.push("Related work is empty");
  }
  if (!hasSubstantiveText(sections.Validation)) {
    reasons.push("Validation is empty or still contains the placeholder");
  }
  if (
    !hasSubstantiveText(sections["Tests and documentation"], {
      allowNaWithReason: true,
    })
  ) {
    reasons.push("Tests and documentation is empty or has an unexplained N/A");
  }

  const compatibility = sections["Compatibility and release impact"];
  const breakingValue = extractCompatibilityValue(
    compatibility,
    "Breaking or externally visible changes",
  );
  const changesetValue = extractCompatibilityValue(compatibility, "Changeset");
  if (!hasSubstantiveText(breakingValue)) {
    reasons.push("Breaking-change impact is empty");
  }
  if (!hasSubstantiveText(changesetValue, { allowNaWithReason: true })) {
    reasons.push("Changeset status is empty or has an unexplained N/A");
  }

  if (!validateExpectedCheckboxes(sections.Security, SECURITY_PREFIXES, 2)) {
    reasons.push("Both security acknowledgements must be present and checked");
  }
  const aiSection = sections["AI assistance"];
  if (!validateExpectedCheckboxes(aiSection, AI_PREFIXES, 1)) {
    reasons.push("Select exactly one AI-assistance acknowledgement");
  } else if (
    isCheckboxChecked(aiSection, "i used ai assistance") &&
    !hasSubstantiveText(stripCheckboxes(aiSection))
  ) {
    reasons.push("Describe the AI assistance and how the result was verified");
  }
  if (!validateExpectedCheckboxes(sections.Checklist, CHECKLIST_PREFIXES, 7)) {
    reasons.push("Every final checklist acknowledgement must be checked");
  }

  return {
    complete: reasons.length === 0,
    reasons,
    typeLabel: primaryType.label,
    typeIsValid: primaryType.valid,
  };
}

function normalizeFilename(filename) {
  return String(filename ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
}

function isLockfile(filename) {
  const basename = filename.split("/").at(-1) ?? filename;
  return (
    basename === "pnpm-lock.yaml" ||
    basename === "yarn.lock" ||
    basename === "package-lock.json"
  );
}

export function isReviewSizeExcluded(filename) {
  const normalized = normalizeFilename(filename);
  return (
    normalized === "pnpm-lock.yaml" ||
    normalized === "yarn.lock" ||
    normalized === "package-lock.json" ||
    normalized.endsWith("/package-lock.json") ||
    normalized.startsWith("packages/tools/src/_generated/")
  );
}

export function calculateReviewSize(files) {
  const changedLines = files.reduce((total, file) => {
    if (isReviewSizeExcluded(file.filename)) return total;
    const additions = Number(file.additions) || 0;
    const deletions = Number(file.deletions) || 0;
    return total + additions + deletions;
  }, 0);

  let label = "size: xlarge";
  if (changedLines <= 100) label = "size: small";
  else if (changedLines <= 500) label = "size: medium";
  else if (changedLines <= 1_000) label = "size: large";

  return { changedLines, label };
}

export function isSensitivePath(filename) {
  const normalized = normalizeFilename(filename);
  const basename = normalized.split("/").at(-1) ?? normalized;

  return (
    normalized.startsWith(".github/") ||
    normalized.startsWith(".claude/") ||
    normalized.startsWith(".claude-plugin/") ||
    normalized.startsWith("scripts/") ||
    normalized === ".changeset/config.json" ||
    normalized === ".npmrc" ||
    normalized === "pnpm-workspace.yaml" ||
    normalized === "PUBLISHING.md" ||
    basename === "CODEOWNERS" ||
    basename === "SECURITY.md" ||
    basename === "package.json" ||
    isLockfile(normalized)
  );
}

function isOpaqueFile(file) {
  return file.patch === undefined || file.patch === null;
}

const RESOLVED_REPOSITORY_PERMISSIONS = new Set([
  "admin",
  "write",
  "read",
  "none",
]);

function normalizeRepositoryPermission(repositoryPermission) {
  return String(repositoryPermission ?? "")
    .trim()
    .toLowerCase();
}

export function classifyContributor(repositoryPermission) {
  const permission = normalizeRepositoryPermission(repositoryPermission);
  return permission === "admin" || permission === "write"
    ? "contributor: trusted"
    : "contributor: external";
}

function shouldInitializeTriage(eventAction, initializeTriage) {
  return (
    eventAction === "opened" ||
    eventAction === "reopened" ||
    (eventAction === "workflow_dispatch" && initializeTriage === true)
  );
}

export function classifyPullRequest({
  pullRequest,
  repositoryPermission,
  permissionResolved = false,
  files,
  eventAction,
  initializeTriage = false,
}) {
  const normalizedPermission =
    normalizeRepositoryPermission(repositoryPermission);
  const repositoryPermissionResolved =
    permissionResolved === true &&
    RESOLVED_REPOSITORY_PERMISSIONS.has(normalizedPermission);
  const contributorLabel = repositoryPermissionResolved
    ? classifyContributor(normalizedPermission)
    : "contributor: external";
  const size = calculateReviewSize(files);
  const template = validatePullRequestTemplate(pullRequest?.body);
  const sensitive = files.some(({ filename }) => isSensitivePath(filename));
  const reportedFileCount = Number(pullRequest?.changed_files) || files.length;
  const opaque = files.some(isOpaqueFile) || reportedFileCount > files.length;
  const external = contributorLabel === "contributor: external";
  const trusted = contributorLabel === "contributor: trusted";
  const manual =
    external &&
    (!repositoryPermissionResolved ||
      !template.complete ||
      sensitive ||
      size.label === "size: large" ||
      size.label === "size: xlarge" ||
      opaque);

  const desiredLabels = new Set();
  // These labels route public contribution intake. Trusted authors are resolved
  // from live repository access and remain outside the labeling pipeline.
  if (!trusted) {
    desiredLabels.add(contributorLabel);
    desiredLabels.add(size.label);
    if (template.typeIsValid) desiredLabels.add(template.typeLabel);
    if (!template.complete) desiredLabels.add("contribution: incomplete");
    if (sensitive) desiredLabels.add("review: sensitive");
    if (manual) desiredLabels.add("review: manual");
  }

  return {
    addNeedsTriage:
      external && shouldInitializeTriage(eventAction, initializeTriage),
    clearAutomationLabels: trusted,
    desiredLabels: [...desiredLabels].sort((a, b) => a.localeCompare(b)),
    hasOpaqueFile: opaque,
    repositoryPermissionResolved,
    reviewSize: size.changedLines,
    synchronizeTypeLabels: trusted || template.typeIsValid,
    templateReasons: template.reasons,
  };
}

export function reconcilePullRequestLabels(currentLabels, classification) {
  const current = new Set(currentLabels);
  const desired = new Set(classification.desiredLabels);
  const managed = new Set(CLASSIFICATION_LABELS);
  if (classification.synchronizeTypeLabels) {
    for (const label of TYPE_LABELS) managed.add(label);
  }
  if (classification.clearAutomationLabels) {
    managed.add("needs-triage");
  }

  const add = [...desired].filter((label) => !current.has(label));
  if (classification.addNeedsTriage && !current.has("needs-triage")) {
    add.push("needs-triage");
  }

  const remove = [...current].filter((label) => {
    const automationArea =
      classification.clearAutomationLabels && label.startsWith("area: ");
    return (managed.has(label) || automationArea) && !desired.has(label);
  });

  return {
    add: add.sort((a, b) => a.localeCompare(b)),
    remove: remove.sort((a, b) => a.localeCompare(b)),
  };
}
