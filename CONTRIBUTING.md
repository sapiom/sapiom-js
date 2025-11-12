# Contributing to Sapiom SDK

Thank you for your interest in contributing to the Sapiom SDK! We welcome contributions from the community.

## Getting Started

### Prerequisites

- Node.js 18.0.0 or higher
- pnpm 8.0.0 or higher

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/sdk.git
   cd sdk
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
- `@sapiom/core` - Core SDK functionality
- `@sapiom/axios` - Axios integration
- `@sapiom/fetch` - Fetch API integration
- `@sapiom/node-http` - Node.js HTTP/HTTPS integration
- `@sapiom/langchain` - LangChain integration

### Working on a Package

```bash
# Navigate to a specific package
cd packages/core

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
pnpm --filter @sapiom/core test

# Watch mode
pnpm --filter @sapiom/core test:watch
```

## Building

```bash
# Build all packages
pnpm build

# Build specific package
pnpm --filter @sapiom/core build

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
