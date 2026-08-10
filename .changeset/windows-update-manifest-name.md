---
"@sapiom/harness-desktop": patch
---

Fix Windows auto-update: the NSIS installer now uses a space-free artifact name
(`Sapiom-Setup-<version>.exe`), so the filename electron-builder records in
`latest.yml` matches the asset GitHub actually stores. Previously the default
spaced name (`Sapiom Setup <version>.exe`) was sanitised to hyphens in the
manifest but to dots in the uploaded asset, so every Windows client 404'd on
update. The release workflow now also fails if any published manifest references
an asset that isn't attached, so this class of mismatch can't ship silently again.
