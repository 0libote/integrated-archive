import assert from "node:assert/strict";
import test from "node:test";
import { ArchiveManager, type ArchiveFile, type ArchiveHost, type VaultEntryKind } from "../src/archive.ts";
import { DEFAULT_SETTINGS, type ArchiveRecord, type ArchiveSettings } from "../src/settings.ts";

interface TestFile extends ArchiveFile {
  frontmatter: Record<string, unknown>;
}

function makeFile(path = "Projects/note.md"): TestFile {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return {
    extension: dot >= 0 ? name.slice(dot + 1) : "",
    frontmatter: {},
    name,
    path,
    stat: { ctime: 100, mtime: 200 },
  };
}

function makeFixture(overrides: Partial<ArchiveSettings> = {}) {
  const settings: ArchiveSettings = { ...DEFAULT_SETTINGS, ...overrides };
  const entries = new Map<string, VaultEntryKind>();
  const files = new Map<string, TestFile>();
  let history: ArchiveRecord[] = [];
  const createdFolders: string[] = [];
  const renames: Array<{ from: string; to: string }> = [];
  let historyError: unknown;
  let metadataError: unknown;

  const host: ArchiveHost<TestFile> = {
    async createFolder(path) {
      createdFolders.push(path);
      entries.set(path, "folder");
    },
    formatDate(timestamp, pattern) {
      return `${pattern}:${timestamp}`;
    },
    getArchiveHistory() {
      return history;
    },
    getEntryKind(path) {
      return entries.get(path) ?? null;
    },
    getFile(path) {
      return files.get(path) ?? null;
    },
    async getFrontmatter(file) {
      return file.frontmatter;
    },
    normalizePath(path) {
      return path.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
    },
    now() {
      return 300;
    },
    async processFrontMatter(file, update) {
      if (metadataError) throw metadataError;
      update(file.frontmatter);
    },
    async renameFile(file, destination) {
      renames.push({ from: file.path, to: destination });
      entries.delete(file.path);
      files.delete(file.path);
      entries.set(destination, "file");
      files.set(destination, file);
      file.path = destination;
      file.name = destination.slice(destination.lastIndexOf("/") + 1);
    },
    async saveArchiveHistory(records) {
      history = records;
      if (historyError) throw historyError;
    },
  };

  return {
    createdFolders,
    entries,
    files,
    getHistory: () => history,
    host,
    manager: new ArchiveManager(host, () => settings),
    renames,
    setHistory(records: ArchiveRecord[]) {
      history = records;
    },
    setHistoryError(error: unknown) {
      historyError = error;
    },
    setMetadataError(error: unknown) {
      metadataError = error;
    },
    settings,
  };
}

test("archives a file and creates the destination folder", async () => {
  const fixture = makeFixture();
  const file = makeFile();

  const result = await fixture.manager.archive(file);

  assert.deepEqual(result, {
    destination: "Archive/note.md",
    historyError: undefined,
    metadataError: undefined,
    originalPath: "Projects/note.md",
  });
  assert.deepEqual(fixture.createdFolders, ["Archive"]);
  assert.deepEqual(fixture.renames, [{ from: "Projects/note.md", to: "Archive/note.md" }]);
  assert.equal(fixture.manager.isArchived(file), true);
  const [record] = fixture.getHistory();
  assert.equal(record?.archivedAt, 300);
  assert.equal(record?.archivedPath, "Archive/note.md");
  assert.equal(record?.originalPath, "Projects/note.md");
  assert.deepEqual(record?.metadata?.properties.map(({ key }) => key), ["tags", "archived", "created", "modified"]);
});

test("preserves the original folder structure when configured", async () => {
  const fixture = makeFixture({ preserveFolders: true });
  const file = makeFile("Projects/Work/note.md");

  const result = await fixture.manager.archive(file);

  assert.equal(result.destination, "Archive/Projects/Work/note.md");
  assert.deepEqual(fixture.createdFolders, ["Archive", "Archive/Projects", "Archive/Projects/Work"]);
});

test("uses a collision suffix without overwriting an existing entry", async () => {
  const fixture = makeFixture();
  fixture.entries.set("Archive", "folder");
  fixture.entries.set("Archive/note.md", "file");
  fixture.entries.set("Archive/note (1).md", "file");

  const result = await fixture.manager.archive(makeFile());

  assert.equal(result.destination, "Archive/note (2).md");
  assert.deepEqual(fixture.createdFolders, []);
});

test("rejects files already inside the archive", async () => {
  const fixture = makeFixture();

  await assert.rejects(() => fixture.manager.archive(makeFile("Archive/note.md")), /already archived/);
  assert.deepEqual(fixture.renames, []);
});

test("rejects an empty archive folder and a file blocking a parent folder", async () => {
  const empty = makeFixture({ archiveFolder: " " });
  await assert.rejects(() => empty.manager.archive(makeFile()), /Choose an archive folder/);

  const blocked = makeFixture({ archiveFolder: "Storage/Archive" });
  blocked.entries.set("Storage", "file");
  await assert.rejects(() => blocked.manager.archive(makeFile()), /Storage is a file/);
  assert.deepEqual(blocked.renames, []);
});

test("keeps an existing archive tag unchanged and writes all configured dates", async () => {
  const fixture = makeFixture({ tag: "#archived", dateFormat: "FORMAT" });
  const file = makeFile();
  file.frontmatter.tags = "existing, #archived";

  await fixture.manager.archive(file);

  assert.equal(file.frontmatter.tags, "existing, #archived");
  assert.equal(file.frontmatter.archived, "FORMAT:300");
  assert.equal(file.frontmatter.created, "FORMAT:100");
  assert.equal(file.frontmatter.modified, "FORMAT:200");
});

test("adds a missing archive tag without discarding existing tags", async () => {
  const fixture = makeFixture({ tag: "#archived" });
  const file = makeFile();
  file.frontmatter.tags = ["existing"];

  await fixture.manager.archive(file);

  assert.deepEqual(file.frontmatter.tags, ["existing", "archived"]);
});

test("preserves existing created and modified dates by default", async () => {
  const fixture = makeFixture();
  const file = makeFile();
  file.frontmatter = { archived: "old", created: "original-created", modified: "original-modified" };

  await fixture.manager.archive(file);

  assert.equal(file.frontmatter.archived, "YYYY-MM-DD:300");
  assert.equal(file.frontmatter.created, "original-created");
  assert.equal(file.frontmatter.modified, "original-modified");
});

test("replaces existing created and modified dates when configured", async () => {
  const fixture = makeFixture({ existingDateAction: "overwrite" });
  const file = makeFile();
  file.frontmatter = { created: "old", modified: "old" };

  await fixture.manager.archive(file);

  assert.equal(file.frontmatter.created, "YYYY-MM-DD:100");
  assert.equal(file.frontmatter.modified, "YYYY-MM-DD:200");
});

test("does not process frontmatter for non-Markdown files", async () => {
  const fixture = makeFixture();
  const file = makeFile("Assets/image.png");
  const originalProcess = fixture.host.processFrontMatter;
  let processed = false;
  fixture.host.processFrontMatter = async (...args) => {
    processed = true;
    return originalProcess(...args);
  };

  await fixture.manager.archive(file);

  assert.equal(processed, false);
  assert.deepEqual(file.frontmatter, {});
});

test("reports a metadata failure after preserving the successful move", async () => {
  const fixture = makeFixture();
  const error = new Error("Invalid YAML");
  fixture.setMetadataError(error);
  const file = makeFile();

  const result = await fixture.manager.archive(file);

  assert.equal(result.destination, "Archive/note.md");
  assert.equal(result.metadataError, error);
  assert.equal(file.path, "Archive/note.md");
});

test("records a history warning without undoing a successful archive", async () => {
  const fixture = makeFixture();
  const error = new Error("Could not save data.json");
  fixture.setHistoryError(error);

  const result = await fixture.manager.archive(makeFile());

  assert.equal(result.historyError, error);
  assert.equal(result.destination, "Archive/note.md");
});

test("restores an archived file to its exact original path", async () => {
  const fixture = makeFixture({ preserveFolders: false });
  const file = makeFile("Projects/Work/note.md");
  file.frontmatter = { archived: "old", created: "original-created", tags: ["active"] };
  const originalFrontmatter = structuredClone(file.frontmatter);
  await fixture.manager.archive(file);

  const result = await fixture.manager.restore(file);

  assert.deepEqual(result, {
    destination: "Projects/Work/note.md",
    historyError: undefined,
    inferredOriginalPath: false,
    metadataError: undefined,
  });
  assert.equal(file.path, "Projects/Work/note.md");
  assert.deepEqual(file.frontmatter, originalFrontmatter);
  assert.deepEqual(fixture.getHistory(), []);
});

test("reports a metadata failure after preserving a successful restore", async () => {
  const fixture = makeFixture();
  const file = makeFile();
  await fixture.manager.archive(file);
  const error = new Error("Invalid YAML");
  fixture.setMetadataError(error);

  const result = await fixture.manager.restore(file);

  assert.equal(result.destination, "Projects/note.md");
  assert.equal(result.metadataError, error);
  assert.equal(file.path, "Projects/note.md");
  assert.deepEqual(fixture.getHistory(), []);
});

test("uses a collision-safe name when restoring", async () => {
  const fixture = makeFixture();
  const file = makeFile("Projects/note.md");
  await fixture.manager.archive(file);
  fixture.entries.set("Projects/note.md", "file");

  const result = await fixture.manager.restore(file);

  assert.equal(result.destination, "Projects/note (1).md");
});

test("infers a legacy restore path when no history exists", async () => {
  const preserved = makeFixture({ preserveFolders: true });
  const nested = makeFile("Archive/Projects/note.md");
  preserved.entries.set(nested.path, "file");
  preserved.files.set(nested.path, nested);
  assert.deepEqual(await preserved.manager.restore(nested), {
    destination: "Projects/note.md",
    historyError: undefined,
    inferredOriginalPath: true,
    metadataError: undefined,
  });

  const flat = makeFixture({ preserveFolders: false });
  const root = makeFile("Archive/legacy.md");
  flat.entries.set(root.path, "file");
  flat.files.set(root.path, root);
  assert.equal((await flat.manager.restore(root)).destination, "legacy.md");
});

test("undoes the most recent archive that still exists", async () => {
  const fixture = makeFixture();
  const file = makeFile("Projects/current.md");
  fixture.entries.set("Archive/current.md", "file");
  fixture.files.set("Archive/current.md", file);
  file.path = "Archive/current.md";
  file.name = "current.md";
  fixture.setHistory([
    { archivedAt: 100, archivedPath: "Archive/missing.md", originalPath: "missing.md" },
    { archivedAt: 200, archivedPath: "Archive/current.md", originalPath: "Projects/current.md" },
  ]);

  assert.equal(fixture.manager.canUndo(), true);
  const result = await fixture.manager.undoLastArchive();

  assert.equal(result.destination, "Projects/current.md");
  assert.equal(fixture.manager.canUndo(), false);
  assert.deepEqual(fixture.getHistory(), [
    { archivedAt: 100, archivedPath: "Archive/missing.md", originalPath: "missing.md" },
  ]);
});

test("recognizes recorded archive files after the archive folder setting changes", () => {
  const fixture = makeFixture({ archiveFolder: "New Archive" });
  const file = makeFile("Old Archive/note.md");
  fixture.setHistory([{ archivedAt: 100, archivedPath: file.path, originalPath: "note.md" }]);

  assert.equal(fixture.manager.isArchived(file), true);
});

test("does not duplicate a tag that differs only in case", async () => {
  const fixture = makeFixture({ tag: "Archived" });
  const file = makeFile();
  file.frontmatter.tags = ["archived"];

  await fixture.manager.archive(file);

  assert.deepEqual(file.frontmatter.tags, ["archived"]);
});

test("rewrites record paths when an archive folder is renamed", async () => {
  const fixture = makeFixture({ preserveFolders: true });
  await fixture.manager.archive(makeFile("Projects/Work/note.md"));
  assert.equal(fixture.getHistory()[0]?.archivedPath, "Archive/Projects/Work/note.md");

  await fixture.manager.reconcileRename("Archive/Projects", "Archive/Stash");

  assert.equal(fixture.getHistory()[0]?.archivedPath, "Archive/Stash/Work/note.md");
});

test("drops records when a file leaves the archive without the plugin", async () => {
  const fixture = makeFixture();
  await fixture.manager.archive(makeFile("Projects/note.md"));
  assert.equal(fixture.getHistory().length, 1);

  await fixture.manager.reconcileRename("Archive/note.md", "Elsewhere/note.md");

  assert.deepEqual(fixture.getHistory(), []);
});

test("restores from a stored original path when history is gone", async () => {
  const fixture = makeFixture({
    addArchivedDate: false,
    addCreatedDate: false,
    addModifiedDate: false,
    addTag: false,
    storeOriginalPath: true,
  });
  const file = makeFile("Projects/Work/note.md");
  await fixture.manager.archive(file);
  assert.equal(file.frontmatter["archive-original-path"], "Projects/Work/note.md");

  fixture.setHistory([]);

  const result = await fixture.manager.restore(file);

  assert.equal(result.destination, "Projects/Work/note.md");
  assert.equal(result.inferredOriginalPath, true);
  assert.equal(file.frontmatter["archive-original-path"], undefined);
});

test("ignores a stored original path that points back into the archive", async () => {
  const fixture = makeFixture({ preserveFolders: false, storeOriginalPath: true });
  const file = makeFile("Archive/legacy.md");
  file.frontmatter["archive-original-path"] = "Archive/legacy.md";
  fixture.entries.set(file.path, "file");
  fixture.files.set(file.path, file);

  const result = await fixture.manager.restore(file);

  assert.equal(result.destination, "legacy.md");
});

test("serializes simultaneous archives without losing history", async () => {
  const fixture = makeFixture();
  const first = makeFile("Projects/first.md");
  const second = makeFile("Projects/second.md");

  await Promise.all([fixture.manager.archive(first), fixture.manager.archive(second)]);

  assert.deepEqual(fixture.getHistory().map(({ archivedPath }) => archivedPath), [
    "Archive/first.md",
    "Archive/second.md",
  ]);
});
