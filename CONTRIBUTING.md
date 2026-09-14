# Contributing to sapiom-js

Thank you for your interest in contributing to `sapiom-js`. We welcome focused,
well-tested improvements from the community. This guide explains which changes
can go straight to a pull request, which need maintainer agreement first, and
what information we need to review your work efficiently.

## Before you start

Choose the path that matches your contribution:

### Open a pull request directly

You can usually open a pull request without prior discussion for:

- focused bug fixes with a clear reproduction;
- documentation corrections;
- fixes to existing examples;
- new templates that follow [`examples/AUTHORING.md`](examples/AUTHORING.md) and
  are limited to one template; and
- tests that clarify existing behavior.

Keep direct pull requests small and limited to one problem.

### Open an issue first

Please [open an issue](https://github.com/sapiom/sapiom-js/issues) and wait for
maintainer agreement before investing in:

- new features, integrations, or packages;
- public API changes or changes to documented compatibility or behavior
  contracts;
- new or replaced dependencies;
- cross-package architectural changes; or
- broad performance work, refactors, or migrations.

Early discussion helps confirm that the change fits the project's direction and
prevents contributors from spending time on work we may not be able to accept.

### Report security vulnerabilities privately

Even if it looks like a bug fix, do not open a public issue or pull request for
a suspected vulnerability. Follow our [Security Policy](SECURITY.md) instead.

### Changes we normally decline

We normally close contributions that contain:

- unsolicited broad refactors or migrations;
- formatting-only or style-only churn unrelated to a functional change;
- multiple unrelated changes in one pull request;
- changes that disable, bypass, or hide failing quality checks;
- unexplained generated or bulk changes; or
- AI-assisted changes the contributor cannot explain and validate.

Maintainers may also decline work that does not fit the project's current
direction or maintenance capacity. Opening an issue or pull request does not
guarantee that the change will be accepted.

## Development setup

### Prerequisites

- Node.js 20.0.0 or higher for full-workspace development and CI. Individual
  SDK packages may retain Node.js 18 runtime support.
- pnpm 10.0.0 or higher (the repository pins pnpm 10.34.3)

### Setup

1. Fork the repository.
2. Clone your fork and configure the upstream repository:

   ```bash
   git clone https://github.com/YOUR_USERNAME/sapiom-js.git
   cd sapiom-js
   git remote add upstream https://github.com/sapiom/sapiom-js.git
   ```

3. Install dependencies from the lockfile:

   ```bash
   pnpm install --frozen-lockfile
   ```

4. Build and test the workspace:

   ```bash
   pnpm build
   pnpm test
   ```

This repository is a monorepo. Published and internal workspace packages live
under [`packages/`](packages/); browse that directory and its package manifests
for the current package list rather than relying on a static catalog.

## Development workflow

For standalone work, create a descriptive branch from the latest `main`:

```bash
git fetch upstream
git checkout -b fix/short-description upstream/main
```

If you have write access to `sapiom/sapiom-js`, use a
[native GitHub stack](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests)
for dependent changes, with `main` as its target. Create each branch from the
preceding branch. The first PR targets `main`; each later PR targets the
preceding branch. All stack branches must be in `sapiom/sapiom-js`. GitHub
applies the stack target's branch rules and CI to each PR. The labeler also uses
the stack target, so each PR must follow the contribution policy and template.

Contributors without write access must submit standalone PRs from a fork,
with `main` as the target.

While iterating, you can run commands for one package with pnpm filters:

```bash
pnpm --filter @sapiom/core build
pnpm --filter @sapiom/core test
pnpm --filter @sapiom/core test:watch
```

Replace `@sapiom/core` with the package you are changing.

## Quality standards

### Keep changes focused

- Solve one problem per pull request.
- Follow the existing design and code style in the affected package.
- Run the affected package's format script when it provides one.
- Avoid drive-by cleanup and unrelated dependency updates.
- Explain non-obvious behavior and tradeoffs in code or documentation.

### TypeScript

- Use TypeScript for source code.
- Preserve strict type safety and avoid `any` when a precise type is practical.
- Document public APIs and externally visible behavior.

### Testing

- Add or update tests for changed behavior.
- Cover relevant success and error paths.
- Use descriptive test names that state the expected behavior.
- Maintain or improve coverage in the changed area.

For source, build, or configuration changes, run the root checks before opening
a pull request:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

When a command does not exercise a documentation-only or test-only change, mark
it as not applicable in the pull request and explain what you validated instead.
All CI checks that run for the pull request must pass.

If you change the example gallery or its manifests, also run the relevant
repository content checks:

```bash
pnpm examples:sort
pnpm examples:check
pnpm examples:check:test
pnpm terminology:check
```

### Mutation testing

`@sapiom/analytics-core` uses
[StrykerJS](https://stryker-mutator.io/) to check whether its tests detect bugs
instead of merely executing lines. Mutation testing is scoped to
delivery-critical logic; see `packages/analytics-core/stryker.conf.json`.

The test is too slow for per-PR CI, so a nightly
[Mutation Testing workflow](.github/workflows/mutation.yml) runs it separately.
Run it locally when you change one of the mutated modules or its tests:

```bash
pnpm --filter @sapiom/analytics-core test:mutation
```

The command writes an interactive report to
`packages/analytics-core/reports/mutation/mutation.html`. Investigate surviving
mutants and strengthen tests where they reveal a real gap. Thresholds live in
`stryker.conf.json`: the run fails below 60, 70 or higher is expected, and 85 or
higher is good. Some mutants are equivalent to the original code and cannot be
killed meaningfully.

### Documentation

For user-facing changes:

- update the relevant README or guide;
- add or update JSDoc for public APIs;
- include an example when it materially improves understanding; and
- call out compatibility or migration requirements.

### Changesets

Add a Changeset when a change affects a published package's behavior, API, or
release notes:

```bash
pnpm changeset
```

A Changeset is normally not needed for documentation-only changes, tests,
repository tooling, or other changes that do not affect a published package.
Mark the Changeset as not applicable in the pull request and explain why.

### Commit messages

Use conventional commit prefixes:

- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `test:` for test changes
- `refactor:` for refactoring
- `chore:` for maintenance

Add a package scope when it makes the change clearer, for example:

```text
fix(core): preserve transaction errors during polling
```

## Pull request process

1. Rebase or merge the latest `upstream/main` into your branch. For a native
   stack, rebase the stack in dependency order.
2. Run the checks relevant to your change.
3. Push the branch to your fork. For a native stack, push all branches to the
   target repository.
4. Open a pull request against `sapiom/sapiom-js:main`. For later PRs in a native
   stack with `main` as its target, use the preceding branch as the PR base.
5. Complete every applicable section of the pull request template. Use `N/A`
   with a short explanation instead of silently deleting a section.
6. Respond to review feedback and keep the branch focused as it evolves.

Maintainers review contributions for correctness, compatibility, scope,
security, maintainability, and fit with the project. They may request changes or
close work that falls outside the policy above. Contributors remain responsible
for the submitted code throughout review, including code produced with AI tools.

## AI-assisted contributions

AI-assisted contributions are allowed, but they are held to the same standards
as any other contribution. If you used an AI tool:

- disclose its use in the pull request;
- describe what it generated or materially changed;
- explain how you reviewed and validated the result;
- make sure you understand and can defend every submitted change; and
- never include secrets, credentials, private data, or code you do not have the
  right to contribute in prompts or generated output.

Maintainers may decline AI-assisted changes that are unverified, unnecessarily
large, or not understood by the contributor.

## Reporting bugs and requesting features

Search [existing issues](https://github.com/sapiom/sapiom-js/issues) before
opening a new one.

For bugs, include:

- the affected SDK version;
- Node.js and pnpm versions;
- operating system;
- a minimal reproduction;
- expected and actual behavior; and
- relevant error messages or sanitized logs.

For feature requests, explain the problem or use case before proposing an API.
Never include credentials, private data, or undisclosed vulnerability details in
a public issue.

## Community expectations

Be respectful, constructive, and patient in issues, pull requests, and reviews.
Disagreement is welcome; harassment and personal attacks are not.

## License

By contributing to `sapiom-js`, you agree that your contributions will be
licensed under the repository's [MIT License](LICENSE).
