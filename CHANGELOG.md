# Changelog

All notable changes to Integrated Archive are documented here.

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
- Added release attestations and addressed initial community review feedback.

## 0.1.0 — 2026-08-02

- Initial release.
