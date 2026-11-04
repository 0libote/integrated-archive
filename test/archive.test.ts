import { expect, test } from "bun:test";
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
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  let history: ArchiveRecord[] = [];
  const createdFolders: string[] = [];
  const deletedFolders: string[] = [];
  const renames: Array<{ from: string; to: string }> = [];
  let historyError: unknown;
  let metadataError: unknown;

  const host: ArchiveHost<TestFile> = {
    async createFolder(path) {
      createdFolders.push(path);
      entries.set(path, "folder");
    },
    async deleteFolder(path) {
      deletedFolders.push(path);
      entries.delete(path);
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
    getFolderChildren(path) {
      if (entries.get(path) !== "folder") return null;
      const prefix = `${path}/`;
      const children = new Set<string>();
      const consider = (key: string): void => {
        if (!key.startsWith(prefix)) return;
        const rest = key.slice(prefix.length);
        if (!rest) return;
        const slash = rest.indexOf("/");
        children.add(slash < 0 ? key : `${path}/${rest.slice(0, slash)}`);
      };
      for (const key of entries.keys()) consider(key);
      for (const key of files.keys()) consider(key);
      return [...children];
    },
    async getFrontmatter(file) {
      return file.frontmatter;
    },
    listIncomingLinks: (destPath: string) => incoming.get(destPath) ?? [],
    listOutgoingLinks: (sourcePath: string) => outgoing.get(sourcePath) ?? [],
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
    deletedFolders,
    entries,
    files,
    getHistory: () => history,
    host,
    incoming,
    manager: new ArchiveManager(host, () => settings),
    outgoing,
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

  expect(result).toEqual({
    cleanedFolders: [],
    destination: "Archive/note.md",
    historyError: undefined,
    metadataError: undefined,
    originalPath: "Projects/note.md",
  });
  expect(fixture.createdFolders).toEqual(["Archive"]);
  expect(fixture.renames).toEqual([{ from: "Projects/note.md", to: "Archive/note.md" }]);
  expect(fixture.manager.isArchived(file)).toBe(true);
  const [record] = fixture.getHistory();
  expect(record?.archivedAt).toBe(300);
  expect(record?.archivedPath).toBe("Archive/note.md");
  expect(record?.originalPath).toBe("Projects/note.md");
  expect(record?.metadata?.properties.map(({ key }) => key)).toEqual(["tags", "archived", "created", "modified"]);
});

test("preserves the original folder structure when configured", async () => {
  const fixture = makeFixture({ preserveFolders: true });
  const file = makeFile("Projects/Work/note.md");

  const result = await fixture.manager.archive(file);

  expect(result.destination).toBe("Archive/Projects/Work/note.md");
  expect(fixture.createdFolders).toEqual(["Archive", "Archive/Projects", "Archive/Projects/Work"]);
});

test("uses a collision suffix without overwriting an existing entry", async () => {
  const fixture = makeFixture();
  fixture.entries.set("Archive", "folder");
  fixture.entries.set("Archive/note.md", "file");
  fixture.entries.set("Archive/note (1).md", "file");

  const result = await fixture.manager.archive(makeFile());

  expect(result.destination).toBe("Archive/note (2).md");
  expect(fixture.createdFolders).toEqual([]);
});

test("rejects files already inside the archive", async () => {
  const fixture = makeFixture();

  await expect(fixture.manager.archive(makeFile("Archive/note.md"))).rejects.toThrow(/already archived/);
  expect(fixture.renames).toEqual([]);
});

test("rejects an empty archive folder and a file blocking a parent folder", async () => {
  const empty = makeFixture({ archiveFolder: " " });
  await expect(empty.manager.archive(makeFile())).rejects.toThrow(/Choose an archive folder/);

  const blocked = makeFixture({ archiveFolder: "Storage/Archive" });
  blocked.entries.set("Storage", "file");
  await expect(blocked.manager.archive(makeFile())).rejects.toThrow(/Storage is a file/);
  expect(blocked.renames).toEqual([]);
});

test("refuses to archive protected paths", async () => {
  const fixture = makeFixture({ excludedPaths: "Private\nTemplates" });

  await expect(fixture.manager.archive(makeFile("Private/secret.md"))).rejects.toThrow(/protected/);
  expect(fixture.renames).toEqual([]);
  expect(fixture.manager.isExcludedPath("Templates/Daily/note.md")).toBe(true);
  expect(fixture.manager.isExcludedPath("Private/note.md")).toBe(true);
  expect(fixture.manager.isExcludedPath("Private2/note.md")).toBe(false);
  expect(fixture.manager.isExcludedPath("Projects/note.md")).toBe(false);
});

test("keeps an existing archive tag unchanged and writes all configured dates", async () => {
  const fixture = makeFixture({ tag: "#archived", dateFormat: "FORMAT" });
  const file = makeFile();
  file.frontmatter.tags = "existing, #archived";

  await fixture.manager.archive(file);

  expect(file.frontmatter.tags).toBe("existing, #archived");
  expect(file.frontmatter.archived).toBe("FORMAT:300");
  expect(file.frontmatter.created).toBe("FORMAT:100");
  expect(file.frontmatter.modified).toBe("FORMAT:200");
});

test("adds a missing archive tag without discarding existing tags", async () => {
  const fixture = makeFixture({ tag: "#archived" });
  const file = makeFile();
  file.frontmatter.tags = ["existing"];

  await fixture.manager.archive(file);

  expect(file.frontmatter.tags).toEqual(["existing", "archived"]);
});

test("preserves existing created and modified dates by default", async () => {
  const fixture = makeFixture();
  const file = makeFile();
  file.frontmatter = { archived: "old", created: "original-created", modified: "original-modified" };

  await fixture.manager.archive(file);

  expect(file.frontmatter.archived).toBe("YYYY-MM-DD:300");
  expect(file.frontmatter.created).toBe("original-created");
  expect(file.frontmatter.modified).toBe("original-modified");
});

test("replaces existing created and modified dates when configured", async () => {
  const fixture = makeFixture({ existingDateAction: "overwrite" });
  const file = makeFile();
  file.frontmatter = { created: "old", modified: "old" };

  await fixture.manager.archive(file);

  expect(file.frontmatter.created).toBe("YYYY-MM-DD:100");
  expect(file.frontmatter.modified).toBe("YYYY-MM-DD:200");
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

  expect(processed).toBe(false);
  expect(file.frontmatter).toEqual({});
});

test("reports a metadata failure after preserving the successful move", async () => {
  const fixture = makeFixture();
  const error = new Error("Invalid YAML");
  fixture.setMetadataError(error);
  const file = makeFile();

  const result = await fixture.manager.archive(file);

  expect(result.destination).toBe("Archive/note.md");
  expect(result.metadataError).toBe(error);
  expect(file.path).toBe("Archive/note.md");
});

test("records a history warning without undoing a successful archive", async () => {
  const fixture = makeFixture();
  const error = new Error("Could not save data.json");
  fixture.setHistoryError(error);

  const result = await fixture.manager.archive(makeFile());

  expect(result.historyError).toBe(error);
  expect(result.destination).toBe("Archive/note.md");
});

test("restores an archived file to its exact original path", async () => {
  const fixture = makeFixture({ preserveFolders: false });
  const file = makeFile("Projects/Work/note.md");
  file.frontmatter = { archived: "old", created: "original-created", tags: ["active"] };
  const originalFrontmatter = structuredClone(file.frontmatter);
  await fixture.manager.archive(file);

  const result = await fixture.manager.restore(file);

  expect(result).toEqual({
    destination: "Projects/Work/note.md",
    historyError: undefined,
    inferredOriginalPath: false,
    metadataError: undefined,
  });
  expect(file.path).toBe("Projects/Work/note.md");
  expect(file.frontmatter).toEqual(originalFrontmatter);
  expect(fixture.getHistory()).toEqual([]);
});

test("reports a metadata failure after preserving a successful restore", async () => {
  const fixture = makeFixture();
  const file = makeFile();
  await fixture.manager.archive(file);
  const error = new Error("Invalid YAML");
  fixture.setMetadataError(error);

  const result = await fixture.manager.restore(file);

  expect(result.destination).toBe("Projects/note.md");
  expect(result.metadataError).toBe(error);
  expect(file.path).toBe("Projects/note.md");
  expect(fixture.getHistory()).toEqual([]);
});

test("uses a collision-safe name when restoring", async () => {
  const fixture = makeFixture();
  const file = makeFile("Projects/note.md");
  await fixture.manager.archive(file);
  fixture.entries.set("Projects/note.md", "file");

  const result = await fixture.manager.restore(file);

  expect(result.destination).toBe("Projects/note (1).md");
});

test("infers a legacy restore path when no history exists", async () => {
  const preserved = makeFixture({ preserveFolders: true });
  const nested = makeFile("Archive/Projects/note.md");
  preserved.entries.set(nested.path, "file");
  preserved.files.set(nested.path, nested);
  expect(await preserved.manager.restore(nested)).toEqual({
    destination: "Projects/note.md",
    historyError: undefined,
    inferredOriginalPath: true,
    metadataError: undefined,
  });

  const flat = makeFixture({ preserveFolders: false });
  const root = makeFile("Archive/legacy.md");
  flat.entries.set(root.path, "file");
  flat.files.set(root.path, root);
  expect((await flat.manager.restore(root)).destination).toBe("legacy.md");
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

  expect(fixture.manager.canUndo()).toBe(true);
  const result = await fixture.manager.undoLastArchive();

  expect(result.destination).toBe("Projects/current.md");
  expect(fixture.manager.canUndo()).toBe(false);
  expect(fixture.getHistory()).toEqual([
    { archivedAt: 100, archivedPath: "Archive/missing.md", originalPath: "missing.md" },
  ]);
});

test("recognizes recorded archive files after the archive folder setting changes", () => {
  const fixture = makeFixture({ archiveFolder: "New Archive" });
  const file = makeFile("Old Archive/note.md");
  fixture.setHistory([{ archivedAt: 100, archivedPath: file.path, originalPath: "note.md" }]);

  expect(fixture.manager.isArchived(file)).toBe(true);
});

test("does not duplicate a tag that differs only in case", async () => {
  const fixture = makeFixture({ tag: "Archived" });
  const file = makeFile();
  file.frontmatter.tags = ["archived"];

  await fixture.manager.archive(file);

  expect(file.frontmatter.tags).toEqual(["archived"]);
});

test("rewrites record paths when an archive folder is renamed", async () => {
  const fixture = makeFixture({ preserveFolders: true });
  await fixture.manager.archive(makeFile("Projects/Work/note.md"));
  expect(fixture.getHistory()[0]?.archivedPath).toBe("Archive/Projects/Work/note.md");

  await fixture.manager.reconcileRename("Archive/Projects", "Archive/Stash");

  expect(fixture.getHistory()[0]?.archivedPath).toBe("Archive/Stash/Work/note.md");
});

test("drops records when a file leaves the archive without the plugin", async () => {
  const fixture = makeFixture();
  await fixture.manager.archive(makeFile("Projects/note.md"));
  expect(fixture.getHistory().length).toBe(1);

  await fixture.manager.reconcileRename("Archive/note.md", "Elsewhere/note.md");

  expect(fixture.getHistory()).toEqual([]);
});

test("keeps a record when a file is renamed inside the archive", async () => {
  const fixture = makeFixture();
  await fixture.manager.archive(makeFile("Projects/note.md"));

  await fixture.manager.reconcileRename("Archive/note.md", "Archive/renamed.md");

  expect(fixture.getHistory()[0]?.archivedPath).toBe("Archive/renamed.md");
  expect(fixture.getHistory()[0]?.originalPath).toBe("Projects/note.md");
});

test("reports when there is nothing to undo", async () => {
  const fixture = makeFixture();

  expect(fixture.manager.canUndo()).toBe(false);
  await expect(fixture.manager.undoLastArchive()).rejects.toThrow(/no archived file/);
});

test("does not write a stored path for non-Markdown files", async () => {
  const fixture = makeFixture({
    addArchivedDate: false,
    addCreatedDate: false,
    addModifiedDate: false,
    addTag: false,
    storeOriginalPath: true,
  });
  const file = makeFile("Assets/image.png");

  await fixture.manager.archive(file);

  expect(file.frontmatter).toEqual({});
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
  expect(file.frontmatter["archive-original-path"]).toBe("Projects/Work/note.md");

  fixture.setHistory([]);

  const result = await fixture.manager.restore(file);

  expect(result.destination).toBe("Projects/Work/note.md");
  expect(result.inferredOriginalPath).toBe(true);
  expect(file.frontmatter["archive-original-path"]).toBe(undefined);
});

test("ignores a stored original path that points back into the archive", async () => {
  const fixture = makeFixture({ preserveFolders: false, storeOriginalPath: true });
  const file = makeFile("Archive/legacy.md");
  file.frontmatter["archive-original-path"] = "Archive/legacy.md";
  fixture.entries.set(file.path, "file");
  fixture.files.set(file.path, file);

  const result = await fixture.manager.restore(file);

  expect(result.destination).toBe("legacy.md");
});

test("serializes simultaneous archives without losing history", async () => {
  const fixture = makeFixture();
  const first = makeFile("Projects/first.md");
  const second = makeFile("Projects/second.md");

  await Promise.all([fixture.manager.archive(first), fixture.manager.archive(second)]);

  expect(fixture.getHistory().map(({ archivedPath }) => archivedPath)).toEqual([
    "Archive/first.md",
    "Archive/second.md",
  ]);
});

test("restores a root-level file without creating a spurious folder", async () => {
  const fixture = makeFixture();
  const file = makeFile("note.md");
  await fixture.manager.archive(file);
  expect(file.path).toBe("Archive/note.md");

  const result = await fixture.manager.restore(file);

  expect(result.destination).toBe("note.md");
  expect(file.path).toBe("note.md");
  expect(fixture.createdFolders.includes("note.m")).toBeFalsy();
});

test("keeps history when the archive folder itself is renamed", async () => {
  const fixture = makeFixture();
  await fixture.manager.archive(makeFile("Projects/note.md"));

  await fixture.manager.reconcileRename("Archive", "Storage/Archive");

  expect(fixture.getHistory()[0]?.archivedPath).toBe("Storage/Archive/note.md");
});

test("keeps history when an ancestor of the archive folder is renamed", async () => {
  const fixture = makeFixture({ archiveFolder: "Storage/Archive" });
  await fixture.manager.archive(makeFile("Projects/note.md"));
  expect(fixture.getHistory()[0]?.archivedPath).toBe("Storage/Archive/note.md");

  await fixture.manager.reconcileRename("Storage", "Vault/Storage");

  expect(fixture.getHistory()[0]?.archivedPath).toBe("Vault/Storage/Archive/note.md");
});

test("infers nested legacy paths even when folder structure is not preserved", async () => {
  const fixture = makeFixture({ preserveFolders: false });
  const file = makeFile("Archive/Projects/note.md");
  fixture.entries.set(file.path, "file");
  fixture.files.set(file.path, file);

  const result = await fixture.manager.restore(file);

  expect(result.destination).toBe("Projects/note.md");
});

test("normalizes existing tag markers when adding the archive tag", async () => {
  const fixture = makeFixture({ tag: "archived" });
  const file = makeFile();
  file.frontmatter.tags = ["#existing"];

  await fixture.manager.archive(file);

  expect(file.frontmatter.tags).toEqual(["existing", "archived"]);
});

test("restores a pristine copy of object-valued properties", async () => {
  const fixture = makeFixture({ existingDateAction: "overwrite" });
  const file = makeFile();
  const original: Record<string, unknown> = { nested: 1 };
  file.frontmatter = { created: original };

  await fixture.manager.archive(file);
  expect(typeof file.frontmatter.created).toBe("string");

  original.nested = 999;
  await fixture.manager.restore(file);

  expect(file.frontmatter.created).toEqual({ nested: 1 });
});

test("blocks restoring into a protected location", async () => {
  const fixture = makeFixture({ excludedPaths: "Private" });
  const file = makeFile("Projects/note.md");
  await fixture.manager.archive(file);
  expect(file.path).toBe("Archive/note.md");

  // Simulate the original location becoming protected after archiving.
  fixture.settings.excludedPaths = "Private\nProjects";

  await expect(fixture.manager.restore(file)).rejects.toThrow(/protected location/);
});

test("ignores a stored original path inside a protected location", async () => {
  const fixture = makeFixture({
    excludedPaths: "Private",
    originalPathProperty: "archive-original-path",
    storeOriginalPath: true,
  });
  const file = makeFile("Archive/legacy.md");
  file.frontmatter["archive-original-path"] = "Private/secret.md";
  fixture.entries.set(file.path, "file");
  fixture.files.set(file.path, file);

  const result = await fixture.manager.restore(file);

  expect(result.destination).toBe("legacy.md");
});

test("refuses to archive when the archive folder is protected", async () => {
  const fixture = makeFixture({ archiveFolder: "Private/Archive", excludedPaths: "Private" });

  await expect(fixture.manager.archive(makeFile("Projects/note.md"))).rejects.toThrow(/protected location/);
});

test("leaves empty folders behind by default", async () => {
  const fixture = makeFixture();
  fixture.entries.set("Projects", "folder");
  const file = registerFile(fixture, "Projects/note.md");

  const result = await fixture.manager.archive(file);

  expect(result.cleanedFolders).toEqual([]);
  expect(fixture.deletedFolders).toEqual([]);
  expect(fixture.entries.get("Projects")).toBe("folder");
});

test("removes folders that become empty after archiving when enabled", async () => {
  const fixture = makeFixture({ cleanEmptyFolders: true });
  fixture.entries.set("Projects", "folder");
  fixture.entries.set("Projects/Sub", "folder");
  const file = registerFile(fixture, "Projects/Sub/note.md");

  const result = await fixture.manager.archive(file);

  expect(result.destination).toBe("Archive/note.md");
  expect(result.cleanedFolders).toEqual(["Projects/Sub", "Projects"]);
  expect(fixture.deletedFolders).toEqual(["Projects/Sub", "Projects"]);
});

test("stops cleanup at the first folder that still contains files", async () => {
  const fixture = makeFixture({ cleanEmptyFolders: true });
  fixture.entries.set("Projects", "folder");
  fixture.entries.set("Projects/Sub", "folder");
  registerFile(fixture, "Projects/keep.md");
  const file = registerFile(fixture, "Projects/Sub/note.md");

  const result = await fixture.manager.archive(file);

  expect(result.cleanedFolders).toEqual(["Projects/Sub"]);
  expect(fixture.deletedFolders).toEqual(["Projects/Sub"]);
  expect(fixture.entries.get("Projects")).toBe("folder");
});

test("never deletes the archive folder or an ancestor containing it", async () => {
  const fixture = makeFixture({ archiveFolder: "Storage/Archive", cleanEmptyFolders: true });
  fixture.entries.set("Storage", "folder");
  const file = registerFile(fixture, "Storage/note.md");

  const result = await fixture.manager.archive(file);

  expect(result.destination).toBe("Storage/Archive/note.md");
  expect(result.cleanedFolders).toEqual([]);
  expect(fixture.deletedFolders).toEqual([]);
  expect(fixture.entries.get("Storage")).toBe("folder");
});

test("handles root-level files without attempting cleanup", async () => {
  const fixture = makeFixture({ cleanEmptyFolders: true });

  const result = await fixture.manager.archive(makeFile("note.md"));

  expect(result.destination).toBe("Archive/note.md");
  expect(result.cleanedFolders).toEqual([]);
  expect(fixture.deletedFolders).toEqual([]);
});

test("treats cleanup failures as non-fatal", async () => {
  const fixture = makeFixture({ cleanEmptyFolders: true });
  fixture.entries.set("Projects", "folder");
  const file = registerFile(fixture, "Projects/note.md");
  fixture.host.deleteFolder = async () => {
    throw new Error("denied");
  };

  const result = await fixture.manager.archive(file);

  expect(result.destination).toBe("Archive/note.md");
  expect(file.path).toBe("Archive/note.md");
  expect(result.cleanedFolders).toEqual([]);
});

function registerFile(fixture: ReturnType<typeof makeFixture>, path: string): TestFile {
  const file = makeFile(path);
  fixture.entries.set(file.path, "file");
  fixture.files.set(file.path, file);
  return file;
}

test("preserves metadata edits made while archived and removes only the archive tag", async () => {
  const fixture = makeFixture();
  const file = makeFile();
  file.frontmatter = { tags: ["active"], archived: "previous" };
  await fixture.manager.archive(file);
  file.frontmatter.tags = ["active", "archived", "new-tag"];
  file.frontmatter.archived = "user-edited";
  delete file.frontmatter.created;
  await fixture.manager.restore(file);
  expect(file.frontmatter).toEqual({ tags: ["active", "new-tag"], archived: "user-edited" });
});

test("restores legacy metadata snapshots without archived values", async () => {
  const fixture = makeFixture();
  const file = makeFile();
  file.frontmatter.tags = ["original"];
  await fixture.manager.archive(file);
  for (const property of fixture.getHistory()[0]!.metadata!.properties) delete property.archivedValue;
  await fixture.manager.restore(file);
  expect(file.frontmatter).toEqual({ tags: ["original"] });
});

test("preserves string tag edits made while archived", async () => {
  const fixture = makeFixture();
  const file = makeFile();
  await fixture.manager.archive(file);
  file.frontmatter.tags = "archived new-tag";
  await fixture.manager.restore(file);
  expect(file.frontmatter.tags).toBe("new-tag");
});

function registerAttachmentFixture(overrides: Partial<ArchiveSettings> = {}) {
  const fixture = makeFixture({ archiveAttachments: true, ...overrides });
  const note = registerFile(fixture, "Projects/note.md");
  const image = registerFile(fixture, "Assets/image.png");
  fixture.outgoing.set(note.path, [image.path]);
  fixture.incoming.set(image.path, [note.path]);
  return { fixture, image, note };
}

test("collects no attachments when the setting is disabled", async () => {
  const fixture = makeFixture();
  registerFile(fixture, "Assets/image.png");
  fixture.outgoing.set("Projects/note.md", ["Assets/image.png"]);

  const plan = await fixture.manager.collectAttachments(makeFile());

  expect(plan).toEqual({ attachments: [], sharedSkipped: [] });
});

test("collects no attachments for non-Markdown files", async () => {
  const fixture = makeFixture({ archiveAttachments: true });
  registerFile(fixture, "Assets/image.png");
  fixture.outgoing.set("Assets/image.png", ["Assets/other.png"]);

  const plan = await fixture.manager.collectAttachments(makeFile("Assets/image.png"));

  expect(plan).toEqual({ attachments: [], sharedSkipped: [] });
});

test("archives exclusively-used attachments with a shared group id", async () => {
  const { fixture, note } = registerAttachmentFixture();

  const result = await fixture.manager.archiveWithAttachments(note);

  expect(result.primary.destination).toBe("Archive/note.md");
  expect(result.attachments.length).toBe(1);
  expect(result.attachments[0]?.destination).toBe("Archive/image.png");
  expect(result.failures).toEqual([]);
  expect(result.sharedSkipped).toEqual([]);
  expect(result.groupId).toBeTruthy();
  const history = fixture.getHistory();
  expect(history.length).toBe(2);
  expect(history.every((record) => record.groupId === result.groupId)).toBeTruthy();
});

test("skips linked notes, canvas files, and missing files", async () => {
  const fixture = makeFixture({ archiveAttachments: true });
  const note = registerFile(fixture, "Projects/note.md");
  registerFile(fixture, "Other/other.md");
  registerFile(fixture, "Boards/board.canvas");
  const image = registerFile(fixture, "Assets/image.png");
  fixture.outgoing.set(note.path, ["Other/other.md", "Boards/board.canvas", "Assets/missing.png", image.path]);
  fixture.incoming.set(image.path, [note.path]);

  const plan = await fixture.manager.collectAttachments(note);

  expect(plan.attachments.map((file) => file.path)).toEqual([image.path]);
  expect(plan.sharedSkipped).toEqual([]);
});

test("skips archived, protected, and shared attachments", async () => {
  const fixture = makeFixture({ archiveAttachments: true, excludedPaths: "Private" });
  const note = registerFile(fixture, "Projects/note.md");
  const shared = registerFile(fixture, "Assets/shared.png");
  const other = registerFile(fixture, "Other/other.md");
  registerFile(fixture, "Private/secret.png");
  fixture.outgoing.set(note.path, ["Archive/old.png", "Private/secret.png", shared.path]);
  fixture.incoming.set(shared.path, [note.path, other.path]);

  const plan = await fixture.manager.collectAttachments(note);

  expect(plan.attachments).toEqual([]);
  expect(plan.sharedSkipped).toEqual([shared.path]);
});

test("includes shared attachments when configured", async () => {
  const { fixture, image, note } = registerAttachmentFixture({ includeSharedAttachments: true });
  registerFile(fixture, "Other/other.md");
  fixture.incoming.set(image.path, [note.path, "Other/other.md"]);

  const plan = await fixture.manager.collectAttachments(note);

  expect(plan.attachments.map((file) => file.path)).toEqual([image.path]);
  expect(plan.sharedSkipped).toEqual([]);
});

test("treats an unreadable link index as shared", async () => {
  const fixture = makeFixture({ archiveAttachments: true });
  const note = registerFile(fixture, "Projects/note.md");
  registerFile(fixture, "Assets/image.png");
  fixture.outgoing.set(note.path, ["Assets/image.png"]);
  fixture.host.listIncomingLinks = () => {
    throw new Error("no index");
  };

  const plan = await fixture.manager.collectAttachments(note);

  expect(plan.attachments).toEqual([]);
  expect(plan.sharedSkipped).toEqual(["Assets/image.png"]);
});

test("archives a note alone without a group id when it has no attachments", async () => {
  const fixture = makeFixture({ archiveAttachments: true });

  const result = await fixture.manager.archiveWithAttachments(makeFile());

  expect(result.primary.destination).toBe("Archive/note.md");
  expect(result.attachments).toEqual([]);
  expect(result.groupId).toBe(undefined);
  expect(fixture.getHistory().length).toBe(1);
  expect("groupId" in fixture.getHistory()[0]!).toBe(false);
});

test("passes an explicit group id through to the archive record", async () => {
  const fixture = makeFixture();

  await fixture.manager.archive(makeFile(), { groupId: "group-1" });

  expect(fixture.getHistory()[0]?.groupId).toBe("group-1");
  expect(fixture.manager.getRecordGroup("Archive/note.md")).toBe("group-1");
  expect(fixture.manager.listGroupArchivedPaths("group-1")).toEqual(["Archive/note.md"]);
  expect(fixture.manager.listGroupArchivedPaths("missing")).toEqual([]);
});

test("restores a note together with its attachments", async () => {
  const { fixture, image, note } = registerAttachmentFixture();

  await fixture.manager.archiveWithAttachments(note);
  const result = await fixture.manager.restoreWithGroup(note);

  expect(result.primary.destination).toBe("Projects/note.md");
  expect(result.attachments.length).toBe(1);
  expect(result.attachments[0]?.destination).toBe("Assets/image.png");
  expect(note.path).toBe("Projects/note.md");
  expect(image.path).toBe("Assets/image.png");
  expect(fixture.getHistory()).toEqual([]);
});

test("records attachment restore failures without losing the note restore", async () => {
  const { fixture, note } = registerAttachmentFixture();
  await fixture.manager.archiveWithAttachments(note);
  fixture.settings.excludedPaths = "Assets";

  const result = await fixture.manager.restoreWithGroup(note);

  expect(result.primary.destination).toBe("Projects/note.md");
  expect(result.attachments).toEqual([]);
  expect(result.failures.length).toBe(1);
  expect(result.failures[0]?.originalPath).toBe("Archive/image.png");
});

test("restores a single file when it has no group", async () => {
  const fixture = makeFixture();
  const file = makeFile();
  await fixture.manager.archive(file);

  const result = await fixture.manager.restoreWithGroup(file);

  expect(result.primary.destination).toBe("Projects/note.md");
  expect(result.attachments).toEqual([]);
  expect(result.groupId).toBe(undefined);
});

test("undoes a grouped archive in one step", async () => {
  const { fixture, image, note } = registerAttachmentFixture();

  await fixture.manager.archiveWithAttachments(note);
  expect(fixture.getHistory().length).toBe(2);

  const result = await fixture.manager.undoLastArchiveGroup();

  expect(result.primary.destination).toBe("Projects/note.md");
  expect(result.attachments.length).toBe(1);
  expect(note.path).toBe("Projects/note.md");
  expect(image.path).toBe("Assets/image.png");
  expect(fixture.getHistory()).toEqual([]);
});
