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

function registerFile(fixture: ReturnType<typeof makeFixture>, path: string): TestFile {
  const file = makeFile(path);
  fixture.entries.set(file.path, "file");
  fixture.files.set(file.path, file);
  return file;
}

function registerAttachmentFixture(overrides: Partial<ArchiveSettings> = {}) {
  const fixture = makeFixture({ archiveAttachments: true, ...overrides });
  const note = registerFile(fixture, "Projects/note.md");
  const image = registerFile(fixture, "Assets/image.png");
  fixture.outgoing.set(note.path, [image.path]);
  fixture.incoming.set(image.path, [note.path]);
  return { fixture, image, note };
}

test("returns no attachments when the outgoing link index throws", async () => {
  const fixture = makeFixture({ archiveAttachments: true });
  const note = registerFile(fixture, "Projects/note.md");
  registerFile(fixture, "Assets/image.png");
  fixture.host.listOutgoingLinks = () => {
    throw new Error("no index");
  };

  const plan = await fixture.manager.collectAttachments(note);

  expect(plan).toEqual({ attachments: [], sharedSkipped: [] });
});

test("records a failure when an attachment disappears before it is archived", async () => {
  const { fixture, image, note } = registerAttachmentFixture();
  const originalGetFile = fixture.host.getFile.bind(fixture.host);
  let calls = 0;
  fixture.host.getFile = (path: string) => {
    if (path === image.path) {
      calls++;
      if (calls > 1) return null;
    }
    return originalGetFile(path);
  };

  const result = await fixture.manager.archiveWithAttachments(note);

  expect(result.primary.destination).toBe("Archive/note.md");
  expect(result.attachments).toEqual([]);
  expect(result.failures.length).toBe(1);
  expect(result.failures[0]?.originalPath).toBe("Assets/image.png");
});

test("records a failure when an attachment archive throws", async () => {
  const { fixture, image, note } = registerAttachmentFixture();
  const originalRename = fixture.host.renameFile.bind(fixture.host);
  fixture.host.renameFile = async (file, destination) => {
    if (file.path === image.path) throw new Error("denied");
    return originalRename(file, destination);
  };

  const result = await fixture.manager.archiveWithAttachments(note);

  expect(result.primary.destination).toBe("Archive/note.md");
  expect(result.attachments).toEqual([]);
  expect(result.failures.length).toBe(1);
  expect(result.failures[0]?.originalPath).toBe(image.path);
});

test("breaks cleanup safely when the folder index throws", async () => {
  const fixture = makeFixture({ cleanEmptyFolders: true });
  fixture.entries.set("Projects", "folder");
  const file = registerFile(fixture, "Projects/note.md");
  fixture.host.getFolderChildren = () => {
    throw new Error("no index");
  };

  const result = await fixture.manager.archive(file);

  expect(result.destination).toBe("Archive/note.md");
  expect(result.cleanedFolders).toEqual([]);
});

test("reports a history error on restore without losing the file", async () => {
  const fixture = makeFixture();
  const file = makeFile();
  await fixture.manager.archive(file);
  const error = new Error("save failed");
  fixture.setHistoryError(error);

  const result = await fixture.manager.restore(file);

  expect(result.destination).toBe("Projects/note.md");
  expect(result.historyError).toBe(error);
  expect(file.path).toBe("Projects/note.md");
});

test("reports metadata cleanup failure for inferred original paths", async () => {
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
  const error = new Error("cannot clean");
  fixture.host.processFrontMatter = async () => {
    throw error;
  };

  const result = await fixture.manager.restore(file);

  expect(result.destination).toBe("Projects/Work/note.md");
  expect(result.metadataError).toBe(error);
  expect(file.path).toBe("Projects/Work/note.md");
});

test("ignores no-op and empty renames without touching history", async () => {
  const fixture = makeFixture();
  const records: ArchiveRecord[] = [
    { archivedAt: 100, archivedPath: "Archive/note.md", originalPath: "Projects/note.md" },
  ];
  fixture.setHistory(records);

  await fixture.manager.reconcileRename("a", "a");
  await fixture.manager.reconcileRename("", "b");

  expect(fixture.getHistory()).toEqual(records);
});

test("returns undefined and empty lists for unknown groups", () => {
  const fixture = makeFixture();

  expect(fixture.manager.getRecordGroup("missing.md")).toBeUndefined();
  expect(fixture.manager.listGroupArchivedPaths("")).toEqual([]);
  expect(fixture.manager.listGroupArchivedPaths("missing")).toEqual([]);
});

test("preserves diverging edits with overwrite and nested objects", async () => {
  const fixture = makeFixture({ existingDateAction: "overwrite" });
  const file = makeFile();
  file.frontmatter = { created: { nested: 1 }, tags: ["active"] };
  await fixture.manager.archive(file);
  expect(typeof file.frontmatter.created).toBe("string");
  // Diverge tags while archived; leave the archived date string untouched
  // so one property diverges (true) and others do not (false).
  file.frontmatter.tags = ["active", "archived", "new-tag"];

  await fixture.manager.restore(file);

  expect(file.frontmatter.tags).toEqual(["active", "new-tag"]);
  expect(file.frontmatter.created).toEqual({ nested: 1 });
});

test("covers object comparison when tags become a plain object", async () => {
  const fixture = makeFixture();
  const file = makeFile();
  file.frontmatter = { tags: ["active"] };
  await fixture.manager.archive(file);
  // Archived tags are an array; replacing with a same-length plain object
  // forces valuesEqual down its generic object path with equal lengths.
  file.frontmatter.tags = { a: "active", b: "archived" };

  await fixture.manager.restore(file);

  expect(file.frontmatter.tags).toEqual({ a: "active", b: "archived" });
});

test("keeps unrelated history when reconciling a rename", async () => {
  const fixture = makeFixture();
  await fixture.manager.archive(makeFile("Projects/note.md"));
  fixture.setHistory([
    ...fixture.getHistory(),
    { archivedAt: 50, archivedPath: "Archive/other.md", originalPath: "Other/other.md" },
  ]);

  await fixture.manager.reconcileRename("Archive/note.md", "Archive/renamed.md");

  expect(fixture.manager.getRecordGroup("Archive/renamed.md")).toBeUndefined();
  expect(fixture.manager.listGroupArchivedPaths("x")).toEqual([]);
  const paths = fixture.getHistory().map((r) => r.archivedPath).sort();
  expect(paths).toEqual(["Archive/other.md", "Archive/renamed.md"]);
});

test("throws when undoing a group whose files are all missing", async () => {
  const fixture = makeFixture();
  fixture.setHistory([
    { archivedAt: 100, archivedPath: "Archive/missing.md", groupId: "g1", originalPath: "missing.md" },
  ]);

  await expect(fixture.manager.undoLastArchiveGroup()).rejects.toThrow(/no archived file/);
});

test("infers the file name when the archived prefix is empty", async () => {
  const fixture = makeFixture();
  const file = makeFile("Archive");
  fixture.entries.set(file.path, "file");
  fixture.files.set(file.path, file);

  const result = await fixture.manager.restore(file);

  expect(result.destination).toBe("Archive (1)");
  expect(result.inferredOriginalPath).toBe(true);
});
