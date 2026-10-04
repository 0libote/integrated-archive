# Changelog

All notable changes to Integrated Archive are documented here.

## 0.4.0 — 2026-10-05

### Added

- Confirm bulk archive and restore operations over 10 files.
- Block restores into protected paths and archiving when the archive folder sits inside a protected path, with a settings validation for overlapping paths.
- Redirect direct `trashFile` deletes to the archive in "Archive automatically" mode.

### Changed

- Hide "Archive all files in current folder" at the vault root so it cannot archive the whole vault.
- Clarified one-file-at-a-time undo ("Undo last file archive"), the 200-record history cap, Markdown-only stored original paths, and folder deletes using the normal flow.
- Normalized stored tags (`#foo` → `foo`) and deep-cloned metadata snapshots.

### Fixed

- Restoring a root-level file no longer creates a spurious `note.m/` folder.
- Renaming the archive folder (or an ancestor) keeps and rewrites archive history instead of dropping it.
- Legacy restores in flat mode recover nested paths (`Archive/Projects/note.md` → `Projects/note.md`).
- Delete prompt no longer double-deletes: archiving consumes the delete, and "Delete" trashes exactly once across one-step and two-step Explorer flows.

## 0.3.2 — 2026-10-04

### Changed

- Updated dev dependencies: `eslint` (10.11.0), `@types/node` (26.6.3), and `globals` (17.13.0).

## 0.3.1 — 2026-09-20

### Security

- Updated the transitive dev dependencies `fast-uri` (3.1.6) and `js-yaml` (4.3.2) to resolve published advisories.

## 0.3.0 — 2026-09-20

### Added

- Optionally store each note's original path in its frontmatter so it can be restored even when archive history is lost or synced from another device.
- Archive every file in a folder from the file menu or the command palette, including nested files.
- Protect vault-relative paths so they are never archived.

### Changed

- Reconcile archive history through the operation queue, removing a race with archive and restore writes.
- Updated dependencies and pinned the Bun package manager to 1.4.2.

### Fixed

- Prevented a configured date property from overwriting the `tags` property.
- Repaired duplicate property names that reused a default name, including collisions with the tag property.
- Reconcile archive history when folders containing archived files are renamed or moved, and drop records whose files leave the archive.
- Matched existing archive tags case-insensitively so they are not duplicated.
- Added collision suffixes correctly for leading-dot files such as `.gitignore`.
- Validated the date format setting.

## 0.2.0 — 2026-08-04

### Added

- Restore archived files to their original locations.
- Undo the most recent available archive operation.
- Archive or restore multiple selected files from the file menu.
- Collision-safe restores when the original path is occupied.
- Reversal of metadata changes when a recorded archive operation is restored.
- Inline validation for archive folders, tags, and metadata property names.
- Automated version bumping and official Obsidian lint checks.

### Changed

- Existing created and last-edited properties are preserved by default, with an option to replace them.
- Invalid or externally edited settings are repaired safely when loaded.
- Delete interception now composes safely with other plugins and unloads cleanly.

### Fixed

- Prevented empty or invalid archive tags from being written to frontmatter.
- Prevented enabled date fields from sharing the same frontmatter property.

## 0.1.2 — 2026-08-02

- Adopted Obsidian 1.13's searchable settings API.

## 0.1.1 — 2026-08-02

- Added release attestations and addressed initial community review feedback.

## 0.1.0 — 2026-08-02

- Initial release.
