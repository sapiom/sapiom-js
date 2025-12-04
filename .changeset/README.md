# Changesets

This folder contains changeset files. These files are used to track changes to packages and generate CHANGELOGs.

## Usage

When you make changes that should be included in a release:

```bash
pnpm changeset
```

Follow the prompts to:
1. Select which packages changed
2. Choose the version bump type (major, minor, patch)
3. Write a summary of the changes

Then the CI will handle publishing when merged to main.

For more info, see https://github.com/changesets/changesets
