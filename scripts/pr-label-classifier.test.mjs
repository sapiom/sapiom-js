import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  calculateReviewSize,
  classifyContributor,
  classifyPullRequest,
  isReviewSizeExcluded,
  isSensitivePath,
  reconcilePullRequestLabels,
  validatePullRequestTemplate,
} from "./pr-label-classifier.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TYPE_OPTIONS = [
  ["Bug fix", "bug"],
  ["Documentation", "documentation"],
  ["Feature", "enhancement"],
  ["Tests", "testing"],
  ["Dependency update", "dependencies"],
  ["Maintenance or refactor", "maintenance"],
];

const CHECKLIST = [
  "I read `CONTRIBUTING.md`, and this contribution follows the policy.",
  "This pull request addresses one focused problem.",
  "I added or updated tests.",
  "I ran the relevant build, typecheck, lint, and test commands.",
  "I updated documentation.",
  "I added a Changeset or explained why it is not applicable.",
  "I can explain and maintain every submitted change.",
];

function checkbox(checked, text) {
  return `- [${checked ? "x" : " "}] ${text}`;
}

function pullRequestBody({
  type = "Bug fix",
  selectedTypes = [type],
  problem = "The SDK returns the wrong value for a documented input.",
  summary = "Correct the focused behavior and cover it with a regression test.",
  related = "N/A",
  validation = "`pnpm test` — passed",
  tests = "Added a regression test and updated the affected documentation.",
  breaking = "None",
  changeset = "N/A — no published package behavior changes",
  security = [true, true],
  ai = [true, false],
  aiDetails = "",
  checklist = CHECKLIST.map(() => true),
} = {}) {
  const types = TYPE_OPTIONS.map(([text]) =>
    checkbox(selectedTypes.includes(text), text),
  ).join("\n");
  const finalChecklist = CHECKLIST.map((text, index) =>
    checkbox(checklist[index], text),
  ).join("\n");

  return `## Primary change type

${types}

## Problem and motivation

${problem}

## Summary and scope

${summary}

## Related work

Related issue or discussion: ${related}

## Validation

${validation}

### Tests and documentation

${tests}

## Compatibility and release impact

- Breaking or externally visible changes: ${breaking}
- Changeset: ${changeset}

## Security

${checkbox(security[0], "I have not included secrets, credentials, private data, or unsanitized logs.")}
${checkbox(security[1], "This pull request does not publicly disclose a suspected vulnerability.")}

## AI assistance

${checkbox(ai[0], "I did not use AI assistance for this change.")}
${checkbox(ai[1], "I used AI assistance and have described it below.")}

${aiDetails}

## Checklist

${finalChecklist}
`;
}

function changedFile(
  filename,
  additions,
  deletions = 0,
  patch = "@@ -1 +1 @@",
) {
  return { filename, additions, deletions, patch };
}

test("a complete PR body passes structural validation", () => {
  const result = validatePullRequestTemplate(pullRequestBody());
  assert.equal(result.complete, true);
  assert.equal(result.typeIsValid, true);
  assert.equal(result.typeLabel, "bug");
  assert.deepEqual(result.reasons, []);
});

test("the checked-in PR template and classifier remain structurally aligned", () => {
  let body = readFileSync(
    path.join(ROOT, ".github", "pull_request_template.md"),
    "utf8",
  );
  body = body
    .replace("- [ ] Bug fix", "- [x] Bug fix")
    .replace(
      "<!-- What problem does this solve, and why is the change needed? -->",
      "The documented behavior fails for a reproducible SDK input.",
    )
    .replace(
      "<!-- Describe what changed, including what is intentionally out of scope. -->",
      "Correct the focused behavior without changing the public API.",
    )
    .replace("Related issue or discussion:", "Related issue or discussion: N/A")
    .replace(
      "```text\n# command — result\n```",
      "```text\npnpm test — passed\n```",
    )
    .replace(
      "<!-- Describe tests and documentation added or updated. Use N/A with a reason when appropriate. -->",
      "Added a focused regression test; documentation is unchanged.",
    )
    .replace(
      "<!-- None, or describe the impact and migration path. -->",
      "None",
    )
    .replace(
      "<!-- Added, or N/A with a reason. -->",
      "N/A — no published package behavior changes",
    )
    .replace(
      "- [ ] I did not use AI assistance for this change.",
      "- [x] I did not use AI assistance for this change.",
    );

  for (const heading of ["Security", "Checklist"]) {
    const expression = new RegExp(`(## ${heading}\\n[\\s\\S]*?)(?=\\n## |$)`);
    body = body.replace(expression, (section) =>
      section.replaceAll("- [ ]", "- [x]"),
    );
  }

  const result = validatePullRequestTemplate(body);
  assert.equal(result.complete, true, result.reasons.join("; "));
  assert.equal(result.typeLabel, "bug");
});

test("every primary change type maps to the intended repository label", () => {
  for (const [type, label] of TYPE_OPTIONS) {
    const result = validatePullRequestTemplate(pullRequestBody({ type }));
    assert.equal(result.complete, true, type);
    assert.equal(result.typeLabel, label, type);
  }
});

test("zero or multiple primary types are incomplete", () => {
  for (const selectedTypes of [[], ["Bug fix", "Tests"]]) {
    const result = validatePullRequestTemplate(
      pullRequestBody({ selectedTypes }),
    );
    assert.equal(result.complete, false);
    assert.equal(result.typeIsValid, false);
    assert.match(result.reasons.join("; "), /exactly one primary change type/);
  }
});

test("blank, placeholder-only, and unexplained N/A fields are rejected", () => {
  const result = validatePullRequestTemplate(
    pullRequestBody({
      problem: "<!-- What problem does this solve? -->",
      validation: "```text\n# command — result\n```",
      tests: "N/A",
      changeset: "N/A",
    }),
  );

  assert.equal(result.complete, false);
  assert.match(result.reasons.join("; "), /Problem and motivation is empty/);
  assert.match(result.reasons.join("; "), /Validation is empty/);
  assert.match(result.reasons.join("; "), /unexplained N\/A/);
});

test("N/A is accepted only where the template permits it", () => {
  const accepted = validatePullRequestTemplate(
    pullRequestBody({
      related: "N/A",
      tests: "N/A — documentation-only change",
      changeset: "N/A — no published packages changed",
    }),
  );
  assert.equal(accepted.complete, true);

  const rejected = validatePullRequestTemplate(
    pullRequestBody({ problem: "N/A — no problem supplied" }),
  );
  assert.equal(rejected.complete, false);
  assert.match(rejected.reasons.join("; "), /Problem and motivation is empty/);
});

test("security, AI, and final acknowledgements are enforced", () => {
  const cases = [
    pullRequestBody({ security: [true, false] }),
    pullRequestBody({ ai: [false, false] }),
    pullRequestBody({ ai: [true, true] }),
    pullRequestBody({
      checklist: CHECKLIST.map((_, index) => index !== 3),
    }),
  ];

  for (const body of cases) {
    assert.equal(validatePullRequestTemplate(body).complete, false);
  }

  const missingAiDetails = validatePullRequestTemplate(
    pullRequestBody({ ai: [false, true] }),
  );
  assert.equal(missingAiDetails.complete, false);
  assert.match(
    missingAiDetails.reasons.join("; "),
    /AI assistance and how the result was verified/,
  );

  const disclosedAiDetails = validatePullRequestTemplate(
    pullRequestBody({
      ai: [false, true],
      aiDetails:
        "Used Codex for implementation and verified all repository checks.",
    }),
  );
  assert.equal(disclosedAiDetails.complete, true);
});

test("only write-equivalent repository permissions are trusted", () => {
  for (const permission of ["admin", "write", "ADMIN", "WRITE"]) {
    assert.equal(classifyContributor(permission), "contributor: trusted");
  }

  for (const permission of [
    "read",
    "none",
    "triage",
    "unexpected",
    undefined,
  ]) {
    assert.equal(classifyContributor(permission), "contributor: external");
  }
});

test("review-size labels honor every boundary", () => {
  for (const [lines, label] of [
    [100, "size: small"],
    [101, "size: medium"],
    [500, "size: medium"],
    [501, "size: large"],
    [1_000, "size: large"],
    [1_001, "size: xlarge"],
  ]) {
    assert.deepEqual(calculateReviewSize([changedFile("src/a.ts", lines)]), {
      changedLines: lines,
      label,
    });
  }
});

test("lockfiles and generated tool sources do not inflate review size", () => {
  for (const filename of [
    "pnpm-lock.yaml",
    "package-lock.json",
    "examples/fetch/package-lock.json",
    "yarn.lock",
    "packages/tools/src/_generated/client.ts",
  ]) {
    assert.equal(isReviewSizeExcluded(filename), true, filename);
  }
  assert.equal(isReviewSizeExcluded("examples/fetch/yarn.lock"), false);
  assert.equal(isReviewSizeExcluded("examples/fetch/pnpm-lock.yaml"), false);

  const result = calculateReviewSize([
    changedFile("pnpm-lock.yaml", 5_000),
    changedFile("examples/fetch/package-lock.json", 2_000),
    changedFile("packages/core/src/index.ts", 40, 10),
  ]);
  assert.deepEqual(result, { changedLines: 50, label: "size: small" });
});

test("sensitive paths cover automation, policy, dependency, and release files", () => {
  for (const filename of [
    ".github/workflows/test.yml",
    ".claude/skills/example/SKILL.md",
    ".claude-plugin/plugin.json",
    ".changeset/config.json",
    ".npmrc",
    "pnpm-workspace.yaml",
    "PUBLISHING.md",
    "scripts/publish-local.mjs",
    "CODEOWNERS",
    ".github/CODEOWNERS",
    "SECURITY.md",
    "package.json",
    "packages/core/package.json",
    "pnpm-lock.yaml",
    "examples/fetch/package-lock.json",
  ]) {
    assert.equal(isSensitivePath(filename), true, filename);
  }

  for (const filename of [
    "packages/core/src/index.ts",
    "docs/getting-started.md",
    ".changeset/bright-birds.md",
  ]) {
    assert.equal(isSensitivePath(filename), false, filename);
  }
});

test("external intake gets deterministic type, size, contributor, and triage labels", () => {
  const classification = classifyPullRequest({
    pullRequest: {
      author_association: "MEMBER",
      body: pullRequestBody(),
    },
    repositoryPermission: "read",
    permissionResolved: true,
    files: [changedFile("packages/core/src/index.ts", 20, 5)],
    eventAction: "opened",
  });

  assert.deepEqual(classification.desiredLabels, [
    "bug",
    "contributor: external",
    "size: small",
  ]);
  assert.equal(classification.addNeedsTriage, true);
  assert.equal(classification.clearAutomationLabels, false);
  assert.equal(classification.synchronizeTypeLabels, true);
});

test("incomplete, sensitive, large, and opaque external PRs route to manual review", () => {
  const cases = [
    {
      body: pullRequestBody({ selectedTypes: [] }),
      files: [changedFile("packages/core/src/index.ts", 5)],
    },
    {
      body: pullRequestBody(),
      files: [changedFile(".github/workflows/test.yml", 5)],
    },
    {
      body: pullRequestBody(),
      files: [changedFile("packages/core/src/index.ts", 700)],
    },
    {
      body: pullRequestBody(),
      files: [changedFile("docs/diagram.png", 0, 0, null)],
    },
    {
      body: pullRequestBody(),
      changedFiles: 3_001,
      files: [changedFile("docs/renamed.md", 0, 0)],
    },
  ];

  for (const fixture of cases) {
    const result = classifyPullRequest({
      pullRequest: {
        body: fixture.body,
        changed_files: fixture.changedFiles,
      },
      repositoryPermission: "read",
      permissionResolved: true,
      files: fixture.files,
      eventAction: "synchronize",
    });
    assert.ok(result.desiredLabels.includes("review: manual"));
  }
});

test("trusted PRs receive no automation-managed labels", () => {
  const result = classifyPullRequest({
    pullRequest: {
      author_association: "NONE",
      body: pullRequestBody({ selectedTypes: [] }),
    },
    repositoryPermission: "admin",
    permissionResolved: true,
    files: [changedFile(".github/workflows/test.yml", 700)],
    eventAction: "opened",
  });

  assert.deepEqual(result.desiredLabels, []);
  assert.equal(result.clearAutomationLabels, true);
  assert.equal(result.synchronizeTypeLabels, true);
  assert.equal(result.addNeedsTriage, false);
});

test("unresolved repository permissions fail closed to external manual review", () => {
  for (const fixture of [
    { repositoryPermission: undefined, permissionResolved: false },
    { repositoryPermission: "unexpected", permissionResolved: true },
    { repositoryPermission: "admin", permissionResolved: false },
  ]) {
    const result = classifyPullRequest({
      pullRequest: { body: pullRequestBody() },
      ...fixture,
      files: [changedFile("packages/core/src/index.ts", 5)],
      eventAction: "synchronize",
    });

    assert.ok(result.desiredLabels.includes("contributor: external"));
    assert.ok(result.desiredLabels.includes("review: manual"));
    assert.ok(!result.desiredLabels.includes("contributor: trusted"));
    assert.equal(result.repositoryPermissionResolved, false);
  }
});

test("needs-triage is initialized only on external intake or explicit backfill", () => {
  const input = {
    pullRequest: { body: pullRequestBody() },
    repositoryPermission: "read",
    permissionResolved: true,
    files: [changedFile("packages/core/src/index.ts", 5)],
  };

  for (const action of ["opened", "reopened"]) {
    assert.equal(
      classifyPullRequest({ ...input, eventAction: action }).addNeedsTriage,
      true,
    );
  }
  for (const action of [
    "edited",
    "synchronize",
    "ready_for_review",
    "converted_to_draft",
    "workflow_dispatch",
  ]) {
    assert.equal(
      classifyPullRequest({ ...input, eventAction: action }).addNeedsTriage,
      false,
      action,
    );
  }
  assert.equal(
    classifyPullRequest({
      ...input,
      eventAction: "workflow_dispatch",
      initializeTriage: true,
    }).addNeedsTriage,
    true,
  );
});

test("trusted reconciliation removes automation labels and preserves unrelated state", () => {
  const classification = classifyPullRequest({
    pullRequest: { body: pullRequestBody() },
    repositoryPermission: "write",
    permissionResolved: true,
    files: [changedFile("packages/core/src/index.ts", 5)],
    eventAction: "synchronize",
  });
  const changes = reconcilePullRequestLabels(
    [
      "bug",
      "contributor: trusted",
      "contributor: external",
      "contributor: member",
      "size: large",
      "documentation",
      "contribution: incomplete",
      "review: sensitive",
      "review: manual",
      "needs-triage",
      "help wanted",
      "area: sdk",
      "area: future-package",
      "claude-code-assisted",
    ],
    classification,
  );

  assert.deepEqual(changes.add, []);
  assert.deepEqual(changes.remove, [
    "area: future-package",
    "area: sdk",
    "bug",
    "contribution: incomplete",
    "contributor: external",
    "contributor: member",
    "contributor: trusted",
    "documentation",
    "needs-triage",
    "review: manual",
    "review: sensitive",
    "size: large",
  ]);
  assert.ok(!changes.remove.includes("help wanted"));
  assert.ok(!changes.remove.includes("claude-code-assisted"));
});

test("reconciliation removes stale trusted access after permission revocation", () => {
  const classification = classifyPullRequest({
    pullRequest: { body: pullRequestBody() },
    repositoryPermission: "read",
    permissionResolved: true,
    files: [changedFile("packages/core/src/index.ts", 5)],
    eventAction: "synchronize",
  });
  const changes = reconcilePullRequestLabels(
    ["contributor: trusted", "size: small", "bug", "help wanted"],
    classification,
  );

  assert.deepEqual(changes.add, ["contributor: external"]);
  assert.deepEqual(changes.remove, ["contributor: trusted"]);
  assert.ok(!changes.remove.includes("help wanted"));
});

test("invalid type selection preserves existing type labels", () => {
  const classification = classifyPullRequest({
    pullRequest: {
      body: pullRequestBody({ selectedTypes: [] }),
    },
    repositoryPermission: "read",
    permissionResolved: true,
    files: [changedFile("packages/core/src/index.ts", 5)],
    eventAction: "edited",
  });
  const changes = reconcilePullRequestLabels(
    ["bug", "dependencies", "needs-triage"],
    classification,
  );

  assert.equal(classification.synchronizeTypeLabels, false);
  assert.ok(!changes.remove.includes("bug"));
  assert.ok(!changes.remove.includes("dependencies"));
  assert.ok(!changes.remove.includes("needs-triage"));
});

test("the path-labeler config declares every intended area mapping", () => {
  const config = readFileSync(
    path.join(ROOT, ".github", "labeler.yml"),
    "utf8",
  );
  const expected = {
    "area: agents": ["packages/agent/**", "packages/agent-runtime/**"],
    "area: studio": ["packages/agent-studio/**", "packages/harness/**"],
    "area: sdk": ["packages/core/**", "packages/analytics-core/**"],
    "area: integrations": ["packages/axios/**", "packages/langchain/**"],
    "area: platform-tools": ["packages/mcp/**", ".claude-plugin/**"],
    "area: examples-docs": ["docs/**", "examples/**", '"*.md"'],
    "area: ci-release": [".github/**", "scripts/**", "pnpm-lock.yaml"],
  };

  for (const [label, globs] of Object.entries(expected)) {
    assert.ok(config.includes(`"${label}":`), label);
    for (const glob of globs) assert.ok(config.includes(glob), glob);
  }
});

test("the privileged workflow stays pinned and never references PR head code or secrets", () => {
  const workflow = readFileSync(
    path.join(ROOT, ".github", "workflows", "pr-labeler.yml"),
    "utf8",
  );

  for (const sha of [
    "bf12e9b00b37c5c0ca2b87b79b2daf7891dbda13",
    "3d3c42e5aac5ba805825da76410c181273ba90b1",
    "3a2844b7e9c422d3c10d287c895573f7108da1b3",
  ]) {
    assert.ok(workflow.includes(sha), sha);
  }
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /pull-requests: write/);
  assert.match(workflow, /getCollaboratorPermissionLevel/);
  assert.match(workflow, /id: classification/);
  assert.match(workflow, /core\.setOutput\(\s*"trusted"/);
  assert.match(
    workflow,
    /if: steps\.classification\.outputs\.trusted == 'false'/,
  );
  assert.ok(
    workflow.indexOf("id: classification") <
      workflow.indexOf("Apply area labels to external pull requests"),
  );
  assert.doesNotMatch(workflow, /author_association/);
  assert.doesNotMatch(workflow, /pull_request\.head|head\.sha|secrets\./);

  const classifier = readFileSync(
    path.join(ROOT, "scripts", "pr-label-classifier.mjs"),
    "utf8",
  );
  assert.doesNotMatch(classifier, /author_association/);
});
