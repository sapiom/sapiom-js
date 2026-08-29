---
"@sapiom/harness-desktop": patch
---

Make the pre-release update channel reachable. Desktop releases are now tagged
`vX.Y.Z` instead of `harness-desktop-vX.Y.Z`, because the old prefix is not valid
semver and the updater silently skipped every release when resolving a
pre-release channel — so an install following betas was told "no published
versions" no matter what had been published. The stable channel was never
affected and keeps updating across the change.

Also adds a persisted `preRelease` preference, so an install can follow betas
without setting `SAPIOM_UPDATE_CHANNEL` — unusable as a real control on macOS,
where a Finder or Dock launch inherits no shell environment. The control that
writes it is a follow-up; the preference and the plumbing land here.
