import { expect, test } from "bun:test";
import { ArchiveManager, type ArchiveFile, type ArchiveHost, type VaultEntryKind } from "../src/archive.ts";
import {
  DEFAULT_SETTINGS,
  parseFolderDestinations,
  sanitizeFolderDestinations,
  sanitizeSettings,
  validateFolderDestinations,
  validateStaleDays,
  type ArchiveRecord,
  type ArchiveSettings,
} from "../src/settings.ts";

interface TestFile extends ArchiveFile {
  frontmatter: Record<string, unknown>;
}

function makeFile(path: string, mtime = 200): TestFile {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return {
    extension: dot >= 0 ? name.slice(dot + 1) : "",
    frontmatter: {},
    name,
    path,
    stat: { ctime: 100, mtime },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function makeFixture(overrides: Partial<ArchiveSettings> = {}, now = 100 * DAY_MS) {
  // Real settings always pass through sanitize on load, so the fixture does
  // the same: destination rules overlapping protected paths are dropped here.
  const settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...overrides });
  const entries = new Map<string, VaultEntryKind>();
  const files = new Map<string, TestFile>();
  let history: ArchiveRecord[] = [];

  const host: ArchiveHost<TestFile> = {
    async createFolder(path) {
      entries.set(path, "folder");
    },
    async deleteFolder(path) {
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
    listIncomingLinks: () => [],
    listOutgoingLinks: () => [],
    normalizePath(path) {
      return path.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
    },
    now() {
      return now;
    },
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
    },
  };

  return {
    entries,
    files,
    getHistory: () => history,
    host,
    manager: new ArchiveManager(host, () => settings),
    setHistory(records: ArchiveRecord[]) {
      history = records;
    },
    settings,
  };
}

function addFile(fixture: ReturnType<typeof makeFixture>, path: string, mtime = 200): TestFile {
  const file = makeFile(path, mtime);
  fixture.files.set(path, file);
  fixture.entries.set(path, "file");
  return file;
}

test("stale archiving stays off unless explicitly enabled", () => {
  expect(sanitizeSettings({}).staleArchiving).toBe(false);
  expect(sanitizeSettings({ staleArchiving: 1 }).staleArchiving).toBe(false);
  expect(sanitizeSettings({ staleArchiving: "true" }).staleArchiving).toBe(false);
  expect(sanitizeSettings({ staleArchiving: null }).staleArchiving).toBe(false);
  expect(sanitizeSettings({ staleArchiving: true }).staleArchiving).toBe(true);
});

test("stale settings sanitize to safe values", () => {
  const defaults = sanitizeSettings({});
  expect(defaults.staleDays).toBe(90);
  expect(defaults.staleFolders).toBe("");
  expect(defaults.folderDestinations).toBe("");
  expect(defaults.showRibbonIcon).toBe(true);
  expect(sanitizeSettings({ staleDays: 30 }).staleDays).toBe(30);
  for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "90", null]) {
    expect(sanitizeSettings({ staleDays: bad }).staleDays).toBe(90);
  }
  expect(sanitizeSettings({ staleFolders: " Projects \n\n Junk " }).staleFolders).toBe("Projects\nJunk");
});

test("folder destinations parse and canonicalize", () => {
  expect(parseFolderDestinations("Projects => Archive/Projects")).toEqual([
    { destination: "Archive/Projects", source: "Projects" },
  ]);
  expect(parseFolderDestinations("  Projects//x  =>  Archive//x  ")).toEqual([
    { destination: "Archive/x", source: "Projects/x" },
  ]);
  expect(parseFolderDestinations("no separator\n=> missing-source\nmissing-dest =>")).toEqual([]);
  expect(parseFolderDestinations("A\\B => C")).toEqual([]);
  expect(parseFolderDestinations("../A => B")).toEqual([]);
  expect(sanitizeSettings({ folderDestinations: "Projects  =>  Archive/Projects\njunk line" }).folderDestinations)
    .toBe("Projects => Archive/Projects");
});

test("folder destinations validate", () => {
  const settings = { ...DEFAULT_SETTINGS, excludedPaths: "Private" };
  expect(validateFolderDestinations("", settings)).toBeUndefined();
  expect(validateFolderDestinations("Projects => Archive/Projects", settings)).toBeUndefined();
  expect(validateFolderDestinations("Projects", settings)).toBe("Use one Source => Destination rule per line.");
  expect(validateFolderDestinations("=> Archive/X", settings)).toBe("Use one Source => Destination rule per line.");
  expect(validateFolderDestinations("Projects => ", settings)).toBe("Use one Source => Destination rule per line.");
  expect(validateFolderDestinations("A\\B => C", settings)).toBe("Use forward slashes.");
  expect(validateFolderDestinations("../A => B", settings)).toContain("segments");
  expect(validateFolderDestinations("A => /abs", settings)).toBeDefined();
  expect(validateFolderDestinations("A => Private/Stuff", settings)).toBe("Destinations overlap protected paths.");
  expect(validateFolderDestinations("A => Private", settings)).toBe("Destinations overlap protected paths.");
});

test("destination rules overlapping protected paths are dropped on load", () => {
  const settings = sanitizeSettings({ excludedPaths: "Private", folderDestinations: "A => Private/X\nB => Cold" });
  expect(settings.folderDestinations).toBe("B => Cold");
  expect(sanitizeFolderDestinations("A => Private", "Private")).toBe("");
});

test("stale day counts validate", () => {
  expect(validateStaleDays("90")).toBeUndefined();
  expect(validateStaleDays("1")).toBeUndefined();
  for (const bad of ["", "0", "-3", "1.5", "abc", "90 days"]) {
    expect(validateStaleDays(bad)).toBe("Enter a whole number of days (1 or more).");
  }
});

test("per-folder destinations route archives with longest match winning", () => {
  const fixture = makeFixture({ folderDestinations: "Projects => Cold/Projects\nProjects/big => Cold/Big" });
  expect(fixture.manager.resolveArchiveFolder("Projects/big/note.md")).toBe("Cold/Big");
  expect(fixture.manager.resolveArchiveFolder("Projects/small/note.md")).toBe("Cold/Projects");
  expect(fixture.manager.resolveArchiveFolder("Projects")).toBe("Cold/Projects");
  expect(fixture.manager.resolveArchiveFolder("Other/note.md")).toBe("Archive");
});

test("archiving lands in the configured destination", async () => {
  const flat = makeFixture({ folderDestinations: "Projects => Cold" });
  const flatFile = addFile(flat, "Projects/note.md");
  const flatResult = await flat.manager.archive(flatFile);
  expect(flatResult.destination).toBe("Cold/note.md");
  expect(flatFile.path).toBe("Cold/note.md");

  const structured = makeFixture({ folderDestinations: "Projects => Cold", preserveFolders: true });
  const nestedFile = addFile(structured, "Projects/sub/note.md");
  const structuredResult = await structured.manager.archive(nestedFile);
  expect(structuredResult.destination).toBe("Cold/Projects/sub/note.md");
});

test("files inside any archive destination still count as archived", async () => {
  const fixture = makeFixture({ folderDestinations: "Projects => Cold" });
  const archived = addFile(fixture, "Archive/old.md");
  const custom = addFile(fixture, "Cold/old.md");
  expect(fixture.manager.isArchivedPath(archived.path)).toBe(true);
  expect(fixture.manager.isArchivedPath(custom.path)).toBe(true);
  await expect(fixture.manager.archive(archived)).rejects.toThrow("already archived");
  await expect(fixture.manager.archive(custom)).rejects.toThrow("already archived");
});

test("destinations inside protected paths refuse to archive", async () => {
  const fixture = makeFixture({ excludedPaths: "Vault", folderDestinations: "Projects => Vault/Cold" });
  // The overlapping rule is dropped on load, so the file uses the global folder.
  expect(fixture.settings.folderDestinations).toBe("");
  const file = addFile(fixture, "Projects/note.md");
  const result = await fixture.manager.archive(file);
  expect(result.destination).toBe("Archive/note.md");
});

test("restores and renames work through custom destinations", async () => {
  const fixture = makeFixture({ folderDestinations: "Projects => Cold", preserveFolders: true });
  const file = addFile(fixture, "Projects/note.md");
  await fixture.manager.archive(file);
  expect(file.path).toBe("Cold/Projects/note.md");
  const restored = await fixture.manager.restore(file);
  expect(restored.destination).toBe("Projects/note.md");
  expect(file.path).toBe("Projects/note.md");

  const second = addFile(fixture, "Projects/other.md");
  await fixture.manager.archive(second);
  await fixture.manager.reconcileRename("Cold", "Cooler");
  expect(fixture.getHistory().map((record) => record.archivedPath)).toEqual(["Cooler/Projects/other.md"]);
});

test("cleanup never removes a folder containing a destination", async () => {
  const fixture = makeFixture({
    cleanEmptyFolders: true,
    folderDestinations: "Projects => Cold/Sub",
  });
  const file = addFile(fixture, "Cold/note.md");
  fixture.entries.set("Cold", "folder");
  const result = await fixture.manager.archive(file);
  expect(result.destination).toBe("Archive/note.md");
  // Cold holds a configured destination, so it survives even when empty.
  expect(result.cleanedFolders).toEqual([]);
  expect(fixture.entries.get("Cold")).toBe("folder");
});

test("stale collection respects age, scope, protection, and skips", () => {
  const now = 100 * DAY_MS;
  const fixture = makeFixture({ staleArchiving: true, staleDays: 90 }, now);
  const old = addFile(fixture, "Projects/old.md", now - 91 * DAY_MS);
  addFile(fixture, "Projects/fresh.md", now - 10 * DAY_MS);
  addFile(fixture, "Archive/older.md", now - 200 * DAY_MS);
  const scoped = makeFixture({ staleArchiving: true, staleDays: 90, staleFolders: "Projects" }, now);
  addFile(scoped, "Projects/old.md", now - 91 * DAY_MS);
  addFile(scoped, "Other/old.md", now - 91 * DAY_MS);
  const guarded = makeFixture({ staleArchiving: true, staleDays: 90, excludedPaths: "Private" }, now);
  addFile(guarded, "Private/old.md", now - 91 * DAY_MS);
  addFile(guarded, "Open/old.md", now - 91 * DAY_MS);

  expect(fixture.manager.collectStaleFiles([...fixture.files.values()]).map((file) => file.path))
    .toEqual(["Projects/old.md"]);
  expect(scoped.manager.collectStaleFiles([...scoped.files.values()]).map((file) => file.path))
    .toEqual(["Projects/old.md"]);
  expect(guarded.manager.collectStaleFiles([...guarded.files.values()]).map((file) => file.path))
    .toEqual(["Open/old.md"]);
  expect(guarded.manager.collectStaleFiles([...guarded.files.values()], ["Open/old.md"])).toEqual([]);

  // Oldest first.
  const ordered = makeFixture({ staleArchiving: true, staleDays: 1 }, now);
  addFile(ordered, "b.md", now - 5 * DAY_MS);
  addFile(ordered, "a.md", now - 9 * DAY_MS);
  addFile(ordered, "c.md", now - 2 * DAY_MS);
  expect(ordered.manager.collectStaleFiles([...ordered.files.values()]).map((file) => file.path))
    .toEqual(["a.md", "b.md", "c.md"]);
  expect(old.path).toBe("Projects/old.md");
});

test("restore to a chosen folder moves the file and drops its history", async () => {
  const fixture = makeFixture();
  const file = addFile(fixture, "Projects/note.md");
  file.frontmatter = { tags: ["active"] };
  await fixture.manager.archive(file);
  expect(file.frontmatter.tags).toEqual(["active", "archived"]);
  fixture.entries.set("Target", "folder");

  const result = await fixture.manager.restore(file, { destinationFolder: "Target" });
  expect(result.destination).toBe("Target/note.md");
  expect(file.frontmatter).toEqual({ tags: ["active"] });
  expect(fixture.getHistory()).toEqual([]);

  // A collision in the chosen folder gets a numbered name. The archived file
  // keeps its collision suffix as its basename, so it restores under it.
  const first = addFile(fixture, "Projects/a.md");
  await fixture.manager.archive(first);
  const clash = addFile(fixture, "Other/a.md");
  await fixture.manager.archive(clash);
  expect(clash.name).toBe("a (1).md");
  fixture.entries.set("Target", "folder");
  const second = await fixture.manager.restore(clash, { destinationFolder: "Target" });
  expect(second.destination).toBe("Target/a (1).md");
  const third = await fixture.manager.restore(first, { destinationFolder: "Target" });
  expect(third.destination).toBe("Target/a.md");
});

test("restore to invalid destinations is rejected", async () => {
  const fixture = makeFixture({ excludedPaths: "Private", folderDestinations: "Projects => Cold" });
  const file = addFile(fixture, "Projects/note.md");
  await fixture.manager.archive(file);
  await expect(fixture.manager.restore(file, { destinationFolder: "" })).rejects.toThrow("Choose a destination folder.");
  await expect(fixture.manager.restore(file, { destinationFolder: "/abs" })).rejects.toThrow("relative to the vault root");
  await expect(fixture.manager.restore(file, { destinationFolder: "../out" })).rejects.toThrow("segments");
  await expect(fixture.manager.restore(file, { destinationFolder: "Private" })).rejects.toThrow("protected location");
  await expect(fixture.manager.restore(file, { destinationFolder: "Cold" })).rejects.toThrow("inside an archive folder");
  await expect(fixture.manager.restore(file, { destinationFolder: "Archive/deep" })).rejects.toThrow("inside an archive folder");
  const live = addFile(fixture, "Other/live.md");
  await expect(fixture.manager.restore(live, { destinationFolder: "Target" })).rejects.toThrow("not archived");
});

test("restore infers the original path through a custom destination", async () => {
  const fixture = makeFixture({ folderDestinations: "Projects => Cold", preserveFolders: true });
  const file = addFile(fixture, "Cold/Projects/legacy.md");
  fixture.setHistory([]);
  const result = await fixture.manager.restore(file);
  expect(result.destination).toBe("Projects/legacy.md");
});
