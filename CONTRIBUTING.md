# Contributing to Sapiom SDK

Thank you for your interest in contributing to the Sapiom SDK! We welcome contributions from the community.

## Getting Started

### Prerequisites

- Node.js 18.0.0 or higher
- pnpm 10.0.0 or higher (the repo pins `pnpm@10.34.3` via `packageManager`)

### Setup

1. Fork the repository
2. Clone your fork:

   ```bash
   git clone https://github.com/YOUR_USERNAME/sapiom-js.git
   cd sapiom-js
   ```

3. Install dependencies:

   ```bash
   pnpm install
   ```

4. Build all packages:

   ```bash
   pnpm build
   ```

5. Run tests:
   ```bash
   pnpm test
   ```

## Development Workflow

### Project Structure

This is a monorepo containing multiple packages:

**Build & run agents**

- `@sapiom/agent` - Authoring contract: `defineAgent`, `defineStep`, directives, types
- `@sapiom/tools` - Typed client for Sapiom capabilities (sandboxes, repos, models, …)
- `@sapiom/cli` - Command line: scaffold, validate, deploy, and schedule agents
- `@sapiom/mcp` - Local developer MCP server (`sapiom-dev`)

**Runtime internals**

- `@sapiom/agent-core` - Pure functions for scaffolding, validating, and operating agents
- `@sapiom/agent-runtime` - Host-agnostic graph-walker runtime
- `@sapiom/analytics-core` - Zero-dependency usage analytics emitter
- `@sapiom/sandbox-preview` - Client-side flow for deploying a web-app preview to a sandbox

**Agent Studio**

- `@sapiom/harness` - CLI-launched local web app that runs your coding agent
- `@sapiom/harness-desktop` - Electron desktop host for the harness (private)
- `@sapiom/agent-studio` - Studio workspace package

**Core SDK**

- `@sapiom/core` - Core SDK functionality
- `@sapiom/fetch` - Fetch API integration

**Deprecated** — not accepting new features; fixes only

- `@sapiom/sandbox` - superseded by `sapiom.sandboxes.*` in `@sapiom/tools`
- `@sapiom/axios`, `@sapiom/node-http` - legacy HTTP integrations
- `@sapiom/langchain`, `@sapiom/langchain-classic` - unmaintained, no longer published

### Working on a Package

```bash
# Navigate to a specific package
cd packages/agent

# Build in watch mode
pnpm dev

# Run tests in watch mode
pnpm test:watch

# Run linter
pnpm lint

# Format code
pnpm format
```

### Making Changes

1. Create a new branch for your changes:

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes and ensure:
   - Tests pass: `pnpm test`
   - Builds succeed: `pnpm build`
   - Types check: `pnpm typecheck`
   - Linting passes: `pnpm lint`

3. Write or update tests for your changes

4. Add a changeset describing your changes:
   ```bash
   pnpm changeset
   ```
   Follow the prompts to describe your changes. This helps with version management and changelog generation.

## Code Standards

### TypeScript

- Use TypeScript for all source code
- Enable strict mode
- Provide proper type annotations
- Avoid `any` types when possible

### Testing

- Write unit tests for all new functionality
- Maintain or improve code coverage
- Use descriptive test names
- Test both success and error cases

### Code Style

- Follow the existing code style
- Use Prettier for formatting (runs automatically)
- Follow ESLint rules
- Write clear, self-documenting code
- Add comments for complex logic

### Commit Messages

We follow conventional commits:

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `test:` - Test changes
- `refactor:` - Code refactoring
- `chore:` - Maintenance tasks

Example:

```
feat(core): add transaction polling support

- Implement TransactionPoller class
- Add polling configuration options
- Update documentation
```

## Pull Request Process

1. Update documentation for any API changes
2. Add tests for new functionality
3. Ensure all tests pass and builds succeed
4. Create a changeset with `pnpm changeset`
5. Push your changes to your fork
6. Open a Pull Request against the `main` branch
7. Fill out the PR template with:
   - Clear description of changes
   - Link to related issues
   - Testing steps
   - Breaking changes (if any)

### PR Requirements

Before submitting:

- [ ] Tests pass (`pnpm test`)
- [ ] Build succeeds (`pnpm build`)
- [ ] Types check (`pnpm typecheck`)
- [ ] Linting passes (`pnpm lint`)
- [ ] Changeset created (`pnpm changeset`)
- [ ] Documentation updated
- [ ] No merge conflicts

## Running Tests

```bash
# Run all tests
pnpm test

# Run tests with coverage
pnpm test:coverage

# Run tests for specific package
pnpm --filter @sapiom/agent test

# Watch mode
pnpm --filter @sapiom/agent test:watch
```

### Mutation Testing

`@sapiom/analytics-core` uses [StrykerJS](https://stryker-mutator.io/) to check that its tests actually catch bugs, not just execute lines. Stryker plants small bugs ("mutants") in the source — flipped comparisons, removed statements, changed constants — and re-runs the tests against each one. A mutant that no test fails on ("survived") is a gap where a real bug would slip through silently.

It is scoped to the delivery-critical logic (envelope builder, consent resolver, batch queue, data truncation, HTTP sender) — see `packages/analytics-core/stryker.conf.json`.

**When to run it:** it is not part of per-PR CI (it's slow). A nightly [Mutation Testing workflow](.github/workflows/mutation.yml) runs it on a schedule and uploads the HTML report as an artifact. Run it locally when you change any of the mutated modules or their tests:

```bash
pnpm --filter @sapiom/analytics-core test:mutation
```

**How to read the report:** the run prints a score table per file and writes an interactive HTML report to `packages/analytics-core/reports/mutation/mutation.html`. Open it in a browser, click into a file, and look at the surviving (❌) mutants — each one shows the exact code change no test noticed. Fix survivors by strengthening tests (assert on the behavior the mutant broke); don't chase 100%, some mutants are equivalent to the original code and unkillable. Thresholds live in `stryker.conf.json`: the run fails below 60 (break), 70+ is expected, 85+ is good.

## Building

```bash
# Build all packages
pnpm build

# Build specific package
pnpm --filter @sapiom/agent build

# Clean build artifacts
pnpm clean
```

## Documentation

- Update README.md files for user-facing changes
- Add JSDoc comments for public APIs
- Include code examples in documentation
- Update CHANGELOG.md via changesets

## Reporting Issues

When reporting issues, please include:

- SDK version
- Node.js version
- Operating system
- Minimal reproduction steps
- Expected vs actual behavior
- Error messages or logs

## Questions?

- Open a GitHub issue for bugs or feature requests
- Check existing issues before creating new ones
- Be respectful and constructive in discussions

## License

By contributing to Sapiom SDK, you agree that your contributions will be licensed under the MIT License.

## Code of Conduct

Please note that this project follows a Code of Conduct. By participating, you are expected to uphold this code. Please report unacceptable behavior to the project maintainers.
