import { expect, test } from "bun:test";
import { ArchiveManager, type ArchiveFile, type ArchiveHost, type VaultEntryKind } from "../src/archive.ts";
import { DEFAULT_SETTINGS, type ArchiveRecord, type ArchiveSettings } from "../src/settings.ts";
import {
  sanitizeSettings,
  validateArchiveFolder,
} from "../src/settings.ts";
import { addCollisionSuffix, isPathInFolder } from "../src/path.ts";

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
  let historyError: unknown;
  const host: ArchiveHost<TestFile> = {
    async createFolder(path) {
      createdFolders.push(path);
      entries.set(path, "folder");
    },
    async deleteFolder(path) {
      entries.delete(path);
    },
    formatDate: (timestamp, pattern) => `${pattern}:${timestamp}`,
    getArchiveHistory: () => history,
    getEntryKind: (path) => entries.get(path) ?? null,
    getFile: (path) => files.get(path) ?? null,
    getFolderChildren: (path) => {
      if (entries.get(path) !== "folder") return null;
      return [];
    },
    async getFrontmatter(file) {
      return file.frontmatter;
    },
    listIncomingLinks: (dest) => incoming.get(dest) ?? [],
    listOutgoingLinks: (source) => outgoing.get(source) ?? [],
    normalizePath: (path) => path.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/"),
    now: () => 300,
    async processFrontMatter(file, update) {
      update(file.frontmatter);
    },
    async renameFile(file, destination) {
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
    createdFolders, entries, files, incoming, outgoing, host,
    getHistory: () => history,
    manager: new ArchiveManager(host, () => settings),
    setHistory: (records: ArchiveRecord[]) => { history = records; },
    setHistoryError: (error: unknown) => { historyError = error; },
    settings,
  };
}

function registerFile(fixture: ReturnType<typeof makeFixture>, path: string): TestFile {
  const file = makeFile(path);
  fixture.entries.set(file.path, "file");
  fixture.files.set(file.path, file);
  return file;
}

test("rejected archive for protected destination creates no folders", async () => {
  const fixture = makeFixture({ archiveFolder: "Private/Archive", excludedPaths: "Private" });
  await expect(fixture.manager.archive(makeFile("Projects/note.md"))).rejects.toThrow(/protected/);
  expect(fixture.createdFolders).toEqual([]);
});

test("record path inside the new archive folder falls back to inference", async () => {
  const fixture = makeFixture();
  const file = makeFile("Projects/note.md");
  await fixture.manager.archive(file);
  expect(file.path).toBe("Archive/note.md");
  fixture.settings.archiveFolder = "Projects";
  const result = await fixture.manager.restore(file);
  expect(result.destination).toBe("note.md");
});

test("record path that became protected still throws instead of redirecting", async () => {
  const fixture = makeFixture();
  const file = makeFile("Projects/note.md");
  await fixture.manager.archive(file);
  fixture.settings.excludedPaths = "Projects";
  await expect(fixture.manager.restore(file)).rejects.toThrow(/protected/);
});

test("group restore continues when the first file is blocked", async () => {
  const fixture = makeFixture({ archiveAttachments: true });
  const note = registerFile(fixture, "Projects/note.md");
  const image = registerFile(fixture, "Assets/image.png");
  fixture.outgoing.set(note.path, [image.path]);
  fixture.incoming.set(image.path, [note.path]);
  await fixture.manager.archiveWithAttachments(note);
  fixture.settings.excludedPaths = "Projects";
  const result = await fixture.manager.restoreWithGroup(note);
  expect(result.primary.destination).toBe("Assets/image.png");
  expect(result.failures.length).toBe(1);
});

test("archiving a live file at a stale recorded path succeeds", async () => {
  // The archive folder moved on, leaving a stale record behind. A new file
  // reusing that path is not archived: it must stay archivable.
  const fixture = makeFixture({ archiveFolder: "New Archive" });
  const file = makeFile("Old Archive/note.md");
  fixture.setHistory([{ archivedAt: 100, archivedPath: file.path, originalPath: "note.md" }]);
  fixture.entries.set(file.path, "file");
  fixture.files.set(file.path, file);
  await fixture.manager.archive(file);
  expect(file.path).toBe("New Archive/note.md");
  expect(fixture.getHistory().length).toBe(2);
});

test("history eviction drops the oldest missing-file records first", async () => {
  const fixture = makeFixture();
  const kept: ArchiveRecord[] = [];
  for (let i = 0; i < 200; i++) {
    const path = `Archive/old${i}.md`;
    kept.push({ archivedAt: i, archivedPath: path, originalPath: `old${i}.md` });
    if (i >= 2) {
      const file = makeFile(path);
      fixture.entries.set(path, "file");
      fixture.files.set(path, file);
    }
  }
  // old0 and old1 are both gone; only one slot needs freeing.
  fixture.setHistory(kept);
  await fixture.manager.archive(makeFile("Projects/new.md"));
  const history = fixture.getHistory();
  expect(history.length).toBe(200);
  expect(history.some((record) => record.archivedPath === "Archive/old0.md")).toBe(false);
  expect(history.some((record) => record.archivedPath === "Archive/old1.md")).toBe(true);
  expect(history.some((record) => record.archivedPath === "Archive/new.md")).toBe(true);
});

test("group ids are unique across rapid calls", () => {
  const fixture = makeFixture();
  const first = fixture.manager.makeGroupId("Projects/note.md");
  const second = fixture.manager.makeGroupId("Projects/note.md");
  expect(first).not.toBe(second);
});

test("history eviction prefers records for missing files", async () => {
  const fixture = makeFixture();
  const kept: ArchiveRecord[] = [];
  for (let i = 0; i < 200; i++) {
    const path = `Archive/old${i}.md`;
    kept.push({ archivedAt: i, archivedPath: path, originalPath: `old${i}.md` });
    if (i >= 1) {
      const file = makeFile(path);
      fixture.entries.set(path, "file");
      fixture.files.set(path, file);
    }
  }
  fixture.setHistory(kept);
  await fixture.manager.archive(makeFile("Projects/new.md"));
  const history = fixture.getHistory();
  expect(history.length).toBe(200);
  expect(history.some((record) => record.archivedPath === "Archive/old0.md")).toBe(false);
  expect(history.some((record) => record.archivedPath === "Archive/new.md")).toBe(true);
});

test("sanitize drops protected lines that overlap the archive folder", () => {
  const settings = sanitizeSettings({ archiveFolder: "Archive", excludedPaths: "Archive\nPrivate" });
  expect(settings.excludedPaths).toBe("Private");
});

test("archive folder with double slashes normalizes instead of resetting", () => {
  expect(validateArchiveFolder("a//b")).toBe(undefined);
  const settings = sanitizeSettings({ archiveFolder: "a//b" });
  expect(settings.archiveFolder).toBe("a/b");
});

test("spaced array tags do not duplicate the archive tag", async () => {
  const fixture = makeFixture({ tag: "archived" });
  const file = makeFile();
  file.frontmatter.tags = [" archived ", "active"];
  await fixture.manager.archive(file);
  expect(file.frontmatter.tags).toEqual([" archived ", "active"]);
});

test("trailing-dot names do not gain a mid-name suffix split", () => {
  expect(addCollisionSuffix("Archive/note.", 1)).toBe("Archive/note. (1)");
});

test("folder root can never count as inside a folder", () => {
  expect(isPathInFolder("Archive/note.md", "")).toBe(false);
  expect(isPathInFolder("Archive/note.md", ".")).toBe(false);
});
