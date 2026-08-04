# Integrated Archive

Integrated Archive moves files out of active work without treating them as disposable.

<p align="center">
  <img src="assets/context-menu.jpeg" alt="Archive below Delete in the file menu" width="260">
  <img src="assets/archive-prompt.jpeg" alt="Archive or delete prompt" width="560">
</p>

## Features

- **Archive current file** command and optional file-menu action.
- Restore archived files to their original locations, or undo the latest available archive operation.
- Archive or restore multiple selected files at once.
- Choose whether Delete asks each time, archives automatically, or uses Obsidian’s normal delete flow.
- The optional prompt offers **Archive / Delete / Cancel**. Delete follows your configured Obsidian trash setting and may be permanent.
- Configurable archive folder with optional original folder structure.
- Optional archive tag and archived, created, and last-edited frontmatter dates.
- Collision-safe names such as `note (1).md`; existing files are never overwritten.
- Files already inside the archive use Obsidian's normal delete flow.
- Existing created and last-edited properties are preserved by default.

## Use

Right-click a file and select **Archive**, or run **Integrated Archive: Archive current file** from the command palette. Configure the folder, delete prompt, tag, property names, folder structure, and date format under **Settings → Integrated Archive**.

Right-click an archived file and select **Restore from archive**, or run **Integrated Archive: Restore current file from archive**. Restores return files to their recorded original paths and use collision-safe names if those paths are occupied. **Integrated Archive: Undo last archive** restores the newest archived file that is still available.

The plugin works locally inside your vault. It has no network access, accounts, telemetry, or external services.

## Install

Integrated Archive requires Obsidian 1.13 or later.

### Community plugins

Once Integrated Archive is listed in the Obsidian Community Plugins directory:

1. Open **Settings → Community plugins**.
2. Select **Browse**, search for **Integrated Archive**, and select **Install**.
3. Select **Enable**.

### Manual installation

1. Download `main.js` and `manifest.json` from the latest [GitHub release](https://github.com/0libote/integrated-archive/releases/latest).
2. Create `<vault>/.obsidian/plugins/integrated-archive/`.
3. Copy both downloaded files into that folder.
4. Reload Obsidian, then enable **Integrated Archive** under **Settings → Community plugins**.

## Install for development

```sh
bun install
bun run build
```

Copy `manifest.json` and `main.js` into:

```text
<vault>/.obsidian/plugins/integrated-archive/
```

Then enable **Integrated Archive** under **Settings → Community plugins**.

Run `bun run dev` while developing and `bun run check` before committing.

`bun run check` verifies release versions, type-checks and bundles the plugin, runs the official Obsidian ESLint rules, and executes the test suite.

## Release

Bump `package.json`, `manifest.json`, and `versions.json` together, then push a tag with that exact version and no `v` prefix:

```sh
bun run bump 0.2.0
bun run check
git add package.json manifest.json versions.json
git commit -m "Release 0.2.0"
git tag 0.2.0
git push origin main 0.2.0
```

GitHub Actions verifies the version, builds the plugin, and creates a release containing the files Obsidian needs.

## License

[MIT](LICENSE)
